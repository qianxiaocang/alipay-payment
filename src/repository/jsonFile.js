'use strict';

/**
 * JSON 文件订单仓储
 *
 * 适用：单实例部署、本地开发、生产首笔验证。
 * 不适用：多实例部署 —— 见 sql.js，或 README「生产化建议」。
 *
 * 原子性来源：
 *   - 所有读-改-写经 _serial() 串行化（Node 单线程 + 队列）
 *   - 落盘用「临时文件 + rename」原子替换
 *   - 回执认领：进程内 Set + 持久化租约（双重判据，崩溃后可自动过期）
 */

const fs = require('fs');
const path = require('path');
const { STATUS, DEFAULT_CONFIRM_LEASE_MS, isoNow } = require('./contract');

class JsonFileOrderRepository {
  /** @param {{filePath?: string}} [opts] */
  constructor(opts = {}) {
    this.filePath = opts.filePath || ':memory:';
    this.memoryOnly = this.filePath === ':memory:';
    /** @type {Map<string, object>} */
    this.orders = new Map();
    /** 串行化读-改-写 */
    this._queue = Promise.resolve();
  }

  async init() {
    if (this.memoryOnly) return;
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this._persistSync();
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed.orders || {})) {
          this.orders.set(k, v);
        }
      }
    } catch (err) {
      throw new Error(`订单存储文件损坏，无法解析：${this.filePath}（${err.message}）`);
    }
  }

  async close() {
    /* 文件实现无需关闭连接 */
  }

  _persistSync() {
    if (this.memoryOnly) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify(
      { version: 1, orders: Object.fromEntries(this.orders) },
      null,
      2,
    );
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.filePath); // 原子替换
  }

  /** 串行化执行，保证读-改-写不交错 */
  _serial(fn) {
    const run = this._queue.then(() => fn());
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async get(outTradeNo) {
    return this.orders.get(outTradeNo) || null;
  }

  async create({ outTradeNo, resourceId, amount, payBefore, goodsName, currency = 'CNY' }) {
    return this._serial(() => {
      if (this.orders.has(outTradeNo)) {
        throw new Error(`订单号重复：${outTradeNo}`);
      }
      const order = {
        out_trade_no: outTradeNo,
        resource_id: resourceId,
        amount,
        currency,
        goods_name: goodsName,
        pay_before: payBefore,
        status: STATUS.PENDING,
        trade_no: null,
        service_result: null,
        created_at: isoNow(),
        paid_at: null,
        fulfilled_at: null,
        confirm_lease_until: null,
      };
      this.orders.set(outTradeNo, order);
      this._persistSync();
      return order;
    });
  }

  /**
   * 两阶段履约第一步：原子占位并只生成一次资源。
   * PENDING/PAID → 生成资源 → PENDING_CONFIRM
   * PENDING_CONFIRM / FULFILLED → 复用已落库资源，绝不重新生成
   */
  async prepareFulfillment({ outTradeNo, tradeNo, createResource }) {
    return this._serial(() => {
      const order = this.orders.get(outTradeNo);
      if (!order) {
        return { order: null, state: null, serviceResult: null, alreadyFulfilled: false };
      }

      if (order.status === STATUS.FULFILLED) {
        return {
          order,
          state: STATUS.FULFILLED,
          serviceResult: order.service_result ?? null,
          alreadyFulfilled: true,
        };
      }

      if (order.status === STATUS.PENDING_CONFIRM) {
        return {
          order,
          state: STATUS.PENDING_CONFIRM,
          serviceResult: order.service_result ?? null,
          alreadyFulfilled: false,
        };
      }

      const serviceResult = createResource();
      order.service_result = serviceResult;
      order.status = STATUS.PENDING_CONFIRM;
      order.trade_no = tradeNo || order.trade_no;
      order.paid_at = order.paid_at || isoNow();
      this._persistSync();
      return { order, state: STATUS.PENDING_CONFIRM, serviceResult, alreadyFulfilled: false };
    });
  }

  /**
   * 认领回执上报权（幂等上报的关键）
   *
   * 判据只有「持久化租约」：
   *   _serial 保证「检查租约 + 写入租约」是原子的，因此同一进程内并发认领
   *   也只有一个能成功（第一个把租约写到未来，其余判定未过期而失败）。
   *   租约过期后可被重新认领，从而支持持有者崩溃后的恢复。
   *
   * 这里刻意【不额外】用进程内 Set 做标记 —— 那样会让崩溃恢复在本进程内
   * 失效（Set 不会随租约过期而清除），反而制造死锁。
   *
   * @returns {Promise<boolean>} true 表示本次调用获得了上报权
   */
  async claimFulfillmentConfirm({ outTradeNo, leaseMs = DEFAULT_CONFIRM_LEASE_MS }) {
    return this._serial(() => {
      const order = this.orders.get(outTradeNo);
      if (!order || order.status !== STATUS.PENDING_CONFIRM) return false;

      // 租约未过期的（可能是本进程崩溃前留下的）不可抢占
      const lease = order.confirm_lease_until ? Date.parse(order.confirm_lease_until) : 0;
      if (Number.isFinite(lease) && lease > Date.now()) return false;

      order.confirm_lease_until = new Date(Date.now() + leaseMs).toISOString();
      order.confirm_attempts = (order.confirm_attempts || 0) + 1;
      this._persistSync();
      return true;
    });
  }

  /** 回执确认成功 → 闭环 */
  async completeFulfillment({ outTradeNo, tradeNo }) {
    return this._serial(() => {
      const order = this.orders.get(outTradeNo);
      if (!order) return null;

      order.status = STATUS.FULFILLED;
      order.trade_no = tradeNo || order.trade_no;
      order.fulfilled_at = isoNow();
      order.paid_at = order.paid_at || order.fulfilled_at;
      order.confirm_lease_until = null;
      order.fulfillment_confirm = {
        ok: true,
        code: '10000',
        sub_code: null,
        sub_msg: null,
        attempts: order.confirm_attempts || 1,
        attempted_at: isoNow(),
      };
      this._persistSync();
      return order;
    });
  }

  /** 回执失败 → 释放认领，订单留在 PENDING_CONFIRM 等待重试 */
  async releaseFulfillmentClaim({ outTradeNo, code = null, subCode = null, subMsg = null }) {
    return this._serial(() => {
      const order = this.orders.get(outTradeNo);
      if (!order) return null;

      order.confirm_lease_until = null;
      order.fulfillment_confirm = {
        ok: false,
        code: code ?? null,
        sub_code: subCode ?? null,
        sub_msg: subMsg ?? null,
        attempts: order.confirm_attempts || 1,
        attempted_at: isoNow(),
      };
      this._persistSync();
      return order;
    });
  }

  /** 回执未闭环的订单，供补偿任务使用 */
  async listPendingFulfillmentConfirm() {
    const out = [];
    for (const order of this.orders.values()) {
      const stuck = order.status === STATUS.PENDING_CONFIRM;
      const closedButUnconfirmed =
        order.status === STATUS.FULFILLED && !order.fulfillment_confirm?.ok;
      if (stuck || closedButUnconfirmed) out.push(order);
    }
    return out;
  }

  async size() {
    return this.orders.size;
  }

  /** 是否支持跨实例互斥（供启动日志与文档提示） */
  get supportsMultiInstance() {
    return false;
  }
}

module.exports = { JsonFileOrderRepository };
