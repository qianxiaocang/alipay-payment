'use strict';

/**
 * SQL 订单仓储（MySQL / PostgreSQL）
 *
 * 适用：多实例生产部署。相比 JSON 文件实现，它提供真正的跨实例原子性：
 *   · prepareFulfillment      —— 事务 + SELECT ... FOR UPDATE 行锁，
 *                                跨实例保证资源只生成一次
 *   · claimFulfillmentConfirm —— 原子 UPDATE + 租约，跨实例保证回执只上报一次
 *   · 唯一主键                —— out_trade_no 重复插入必然失败
 *
 * 方言处理：
 *   所有 SQL 统一用 `?` 占位，PG 由 _adapt() 转成 `$1,$2...`；
 *   时间统一由 JS 传 Date 对象（mysql 连接强制 UTC，见 _poolConfig），
 *   读取时统一转成 ISO 字符串，保证两种数据库对外语义一致。
 *
 * 金额用 VARCHAR 存「定点小数字符串」，不做浮点运算（清单要求十进制定点）。
 */

const {
  STATUS,
  STATUS_VALUES,
  DEFAULT_CONFIRM_LEASE_MS,
  isoNow,
} = require('./contract');

/** 各数据库的建表语句（与 migrations/ 下文件保持一致） */
const SCHEMA = {
  mysql: [
    `CREATE TABLE IF NOT EXISTS aipay_orders (
       out_trade_no   VARCHAR(64)   NOT NULL,
       resource_id    VARCHAR(512)  NOT NULL,
       amount         VARCHAR(32)   NOT NULL,
       currency       VARCHAR(8)    NOT NULL DEFAULT 'CNY',
       goods_name     VARCHAR(256)  NOT NULL,
       pay_before     VARCHAR(64)   NOT NULL,
       status         VARCHAR(24)   NOT NULL,
       trade_no       VARCHAR(64)   NULL,
       service_result MEDIUMTEXT    NULL,
       confirm_lease_until DATETIME(3) NULL,
       confirm_attempts    INT NOT NULL DEFAULT 0,
       fulfillment_confirm_ok       TINYINT(1)   NULL,
       fulfillment_confirm_code     VARCHAR(64)  NULL,
       fulfillment_confirm_sub_code VARCHAR(64)  NULL,
       fulfillment_confirm_sub_msg  VARCHAR(512) NULL,
       fulfillment_confirm_attempts INT NULL,
       created_at     DATETIME(3) NOT NULL,
       paid_at        DATETIME(3) NULL,
       fulfilled_at   DATETIME(3) NULL,
       PRIMARY KEY (out_trade_no),
       KEY idx_aipay_status (status),
       KEY idx_aipay_confirm_lease (confirm_lease_until)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  postgres: [
    `CREATE TABLE IF NOT EXISTS aipay_orders (
       out_trade_no   VARCHAR(64)   PRIMARY KEY,
       resource_id    VARCHAR(512)  NOT NULL,
       amount         VARCHAR(32)   NOT NULL,
       currency       VARCHAR(8)    NOT NULL DEFAULT 'CNY',
       goods_name     VARCHAR(256)  NOT NULL,
       pay_before     VARCHAR(64)   NOT NULL,
       status         VARCHAR(24)   NOT NULL,
       trade_no       VARCHAR(64)   NULL,
       service_result TEXT          NULL,
       confirm_lease_until TIMESTAMPTZ NULL,
       confirm_attempts    INTEGER NOT NULL DEFAULT 0,
       fulfillment_confirm_ok       BOOLEAN      NULL,
       fulfillment_confirm_code     VARCHAR(64)  NULL,
       fulfillment_confirm_sub_code VARCHAR(64)  NULL,
       fulfillment_confirm_sub_msg  VARCHAR(512) NULL,
       fulfillment_confirm_attempts INTEGER NULL,
       created_at     TIMESTAMPTZ NOT NULL,
       paid_at        TIMESTAMPTZ NULL,
       fulfilled_at   TIMESTAMPTZ NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_aipay_status ON aipay_orders (status)`,
    `CREATE INDEX IF NOT EXISTS idx_aipay_confirm_lease ON aipay_orders (confirm_lease_until)`,
  ],
};

const SUPPORTED = ['mysql', 'postgres'];

class SqlOrderRepository {
  /**
   * @param {object} opts
   * @param {'mysql'|'postgres'} opts.dialect
   * @param {object} opts.connection 驱动连接参数
   * @param {string} [opts.table]
   * @param {number} [opts.confirmLeaseMs]
   * @param {boolean} [opts.autoMigrate] 启动时自动建表（默认 true）
   */
  constructor(opts = {}) {
    if (!SUPPORTED.includes(opts.dialect)) {
      throw new Error(`不支持的数据库方言：${opts.dialect}（可选 ${SUPPORTED.join(' / ')}）`);
    }
    this.dialect = opts.dialect;
    this.connection = opts.connection || {};
    this.table = opts.table || 'aipay_orders';
    this.confirmLeaseMs = opts.confirmLeaseMs || DEFAULT_CONFIRM_LEASE_MS;
    this.autoMigrate = opts.autoMigrate !== false;
    this.pool = null;
  }

  get supportsMultiInstance() {
    return true;
  }

  // ------------------------------------------------------------ 连接管理

  _poolConfig() {
    if (this.dialect === 'mysql') {
      return {
        ...this.connection,
        waitForConnections: true,
        connectionLimit: Number(this.connection.connectionLimit || 10),
        // 强制按 UTC 解释 DATETIME，否则时间会随服务器时区漂移
        timezone: 'Z',
        supportBigNumbers: true,
      };
    }
    return { ...this.connection };
  }

  async init() {
    if (this.pool) return;

    if (this.dialect === 'mysql') {
      let mysql;
      try {
        mysql = require('mysql2/promise');
      } catch {
        throw new Error('缺少依赖 mysql2，请执行：npm install mysql2');
      }
      this.pool = mysql.createPool(this._poolConfig());
    } else {
      let pg;
      try {
        pg = require('pg');
      } catch {
        throw new Error('缺少依赖 pg，请执行：npm install pg');
      }
      this.pool = new pg.Pool(this._poolConfig());
    }

    // 建表（幂等）
    if (this.autoMigrate) {
      for (const stmt of SCHEMA[this.dialect]) {
        await this._raw(stmt, []);
      }
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  // ------------------------------------------------------------ 驱动差异抹平

  /** 把统一使用 `?` 的 SQL 转成当前方言的占位符 */
  _adapt(sql) {
    if (this.dialect !== 'postgres') return sql;
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  /** 直接执行（自动建表等无参数语句走这里） */
  async _raw(sql, params) {
    const text = this._adapt(sql);
    if (this.dialect === 'mysql') {
      const [rows] = await this.pool.query(text, params);
      return { rows: Array.isArray(rows) ? rows : [], rowCount: rows?.affectedRows ?? 0 };
    }
    const res = await this.pool.query(text, params);
    return { rows: res.rows || [], rowCount: res.rowCount ?? 0 };
  }

  /** 在给定连接上执行 */
  async _exec(conn, sql, params) {
    const text = this._adapt(sql);
    if (this.dialect === 'mysql') {
      const [rows] = await conn.query(text, params);
      return { rows: Array.isArray(rows) ? rows : [], rowCount: rows?.affectedRows ?? 0 };
    }
    const res = await conn.query(text, params);
    return { rows: res.rows || [], rowCount: res.rowCount ?? 0 };
  }

  /** 事务包装：自动 BEGIN / COMMIT / ROLLBACK 与连接归还 */
  async _tx(fn) {
    const conn = this.dialect === 'mysql' ? await this.pool.getConnection() : await this.pool.connect();
    try {
      await conn.query('BEGIN');
      const result = await fn(conn);
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await conn.query('ROLLBACK');
      } catch {
        /* 回滚失败不影响原始错误抛出 */
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  // ------------------------------------------------------------ 行映射

  _toIso(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }

  _map(row) {
    if (!row) return null;
    const toBool = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'boolean') return v;
      return Number(v) === 1;
    };
    const attempts = row.fulfillment_confirm_attempts;
    return {
      out_trade_no: row.out_trade_no,
      resource_id: row.resource_id,
      amount: row.amount,
      currency: row.currency,
      goods_name: row.goods_name,
      pay_before: row.pay_before,
      status: row.status,
      trade_no: row.trade_no ?? null,
      service_result: row.service_result ?? null,
      created_at: this._toIso(row.created_at),
      paid_at: this._toIso(row.paid_at),
      fulfilled_at: this._toIso(row.fulfilled_at),
      confirm_lease_until: this._toIso(row.confirm_lease_until),
      confirm_attempts: row.confirm_attempts ?? 0,
      fulfillment_confirm: attempts === null || attempts === undefined
        ? undefined
        : {
            ok: toBool(row.fulfillment_confirm_ok) === true,
            code: row.fulfillment_confirm_code ?? null,
            sub_code: row.fulfillment_confirm_sub_code ?? null,
            sub_msg: row.fulfillment_confirm_sub_msg ?? null,
            attempts,
          },
    };
  }

  // ------------------------------------------------------------ 接口实现

  async create({ outTradeNo, resourceId, amount, payBefore, goodsName, currency = 'CNY' }) {
    try {
      await this._raw(
        `INSERT INTO ${this.table}
           (out_trade_no, resource_id, amount, currency, goods_name, pay_before, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [outTradeNo, resourceId, amount, currency, goodsName, payBefore, STATUS.PENDING, new Date()],
      );
    } catch (err) {
      // 唯一主键冲突 → 明确的重复订单语义（并发下也只会有一个成功）
      if (err && (err.code === 'ER_DUP_ENTRY' || err.code === '23505')) {
        throw new Error(`订单号重复：${outTradeNo}`);
      }
      throw err;
    }
    return this.get(outTradeNo);
  }

  async get(outTradeNo) {
    const { rows } = await this._raw(`SELECT * FROM ${this.table} WHERE out_trade_no = ?`, [outTradeNo]);
    return this._map(rows[0]);
  }

  /**
   * 两阶段履约第一步：事务内加行锁，保证资源只生成一次。
   * createResource 在持锁期间执行 —— 与官方参考实现语义一致。
   */
  async prepareFulfillment({ outTradeNo, tradeNo, createResource }) {
    return this._tx(async (conn) => {
      const { rows } = await this._exec(
        conn,
        `SELECT * FROM ${this.table} WHERE out_trade_no = ? FOR UPDATE`,
        [outTradeNo],
      );
      const row = rows[0];
      if (!row) {
        return { order: null, state: null, serviceResult: null, alreadyFulfilled: false };
      }

      const order = this._map(row);

      if (order.status === STATUS.FULFILLED) {
        return {
          order,
          state: STATUS.FULFILLED,
          serviceResult: order.service_result,
          alreadyFulfilled: true,
        };
      }

      if (order.status === STATUS.PENDING_CONFIRM) {
        return {
          order,
          state: STATUS.PENDING_CONFIRM,
          serviceResult: order.service_result,
          alreadyFulfilled: false,
        };
      }

      const serviceResult = createResource();
      await this._exec(
        conn,
        `UPDATE ${this.table}
            SET status = ?, service_result = ?,
                trade_no = COALESCE(?, trade_no),
                paid_at  = COALESCE(paid_at, ?)
          WHERE out_trade_no = ?`,
        [STATUS.PENDING_CONFIRM, serviceResult, tradeNo || null, new Date(), outTradeNo],
      );

      const updated = await this.get(outTradeNo);
      return { order: updated, state: STATUS.PENDING_CONFIRM, serviceResult, alreadyFulfilled: false };
    });
  }

  /**
   * 跨实例认领回执上报权：原子 UPDATE + 租约。
   * 只有 status=PENDING_CONFIRM 且租约空闲（或已过期）时才能拿到。
   */
  async claimFulfillmentConfirm({ outTradeNo, leaseMs = this.confirmLeaseMs }) {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const { rowCount } = await this._raw(
      `UPDATE ${this.table}
          SET confirm_lease_until = ?, confirm_attempts = confirm_attempts + 1
        WHERE out_trade_no = ?
          AND status = ?
          AND (confirm_lease_until IS NULL OR confirm_lease_until < ?)`,
      [leaseUntil, outTradeNo, STATUS.PENDING_CONFIRM, now],
    );
    return rowCount === 1;
  }

  /** 回执确认成功 → 闭环 */
  async completeFulfillment({ outTradeNo, tradeNo }) {
    await this._raw(
      `UPDATE ${this.table}
          SET status = ?,
              trade_no = COALESCE(?, trade_no),
              fulfilled_at = ?,
              paid_at = COALESCE(paid_at, ?),
              confirm_lease_until = NULL,
              fulfillment_confirm_ok = ?,
              fulfillment_confirm_code = ?,
              fulfillment_confirm_sub_code = NULL,
              fulfillment_confirm_sub_msg = NULL,
              fulfillment_confirm_attempts = confirm_attempts
        WHERE out_trade_no = ?`,
      [STATUS.FULFILLED, tradeNo || null, new Date(), new Date(), true, '10000', outTradeNo],
    );
    return this.get(outTradeNo);
  }

  /** 回执失败 → 释放租约，订单留在 PENDING_CONFIRM 等待重试 */
  async releaseFulfillmentClaim({ outTradeNo, code = null, subCode = null, subMsg = null }) {
    await this._raw(
      `UPDATE ${this.table}
          SET confirm_lease_until = NULL,
              fulfillment_confirm_ok = ?,
              fulfillment_confirm_code = ?,
              fulfillment_confirm_sub_code = ?,
              fulfillment_confirm_sub_msg = ?,
              fulfillment_confirm_attempts = confirm_attempts
        WHERE out_trade_no = ?`,
      [false, code, subCode, subMsg ? String(subMsg).slice(0, 500) : null, outTradeNo],
    );
    return this.get(outTradeNo);
  }

  /** 回执未闭环的订单，供补偿任务使用 */
  async listPendingFulfillmentConfirm(limit = 100) {
    const { rows } = await this._raw(
      `SELECT * FROM ${this.table}
        WHERE status = ?
           OR (status = ? AND (fulfillment_confirm_ok IS NULL OR fulfillment_confirm_ok = ?))
        ORDER BY created_at ASC
        LIMIT ?`,
      [STATUS.PENDING_CONFIRM, STATUS.FULFILLED, false, Number(limit)],
    );
    return rows.map((r) => this._map(r));
  }

  async size() {
    const { rows } = await this._raw(`SELECT COUNT(*) AS c FROM ${this.table}`, []);
    return Number(rows[0]?.c ?? 0);
  }
}

module.exports = { SqlOrderRepository, SCHEMA, SUPPORTED, STATUS_VALUES };
