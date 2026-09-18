'use strict';

/**
 * 订单存储（含履约幂等 / 防重放）
 *
 * 为什么必须有这一层：
 *   官方示例里订单查询、资源ID校验、履约防重放都是【TODO】注释。
 *   但这三件事直接对应真实资金风险：
 *     - 凭证校验通过 ≠ 这个订单属于本次请求的资源（防资源串改）
 *     - 消费者可能重复携带同一份 Payment-Proof 请求（防重复履约/重复扣费争议）
 *   因此这里落地为真实实现。
 *
 * 存储形态：
 *   - 默认 JSON 文件，原子写入（临时文件 + rename）
 *   - ORDER_STORE_PATH=':memory:' 时纯内存，供测试使用
 *
 * ⚠️ 生产建议：这是一个可用的最小实现，但高并发/多实例部署请替换为
 *    Redis 或数据库（并以数据库唯一索引作为幂等的最终保证）。
 */

const fs = require('fs');
const path = require('path');

/** 订单状态 */
const STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FULFILLED: 'FULFILLED',
};

class OrderStore {
  /** @param {{filePath?: string}} [opts] */
  constructor(opts = {}) {
    this.filePath = opts.filePath || ':memory:';
    this.memoryOnly = this.filePath === ':memory:';
    /** @type {Map<string, object>} */
    this.orders = new Map();
    /** 串行化写入，避免并发请求互相覆盖 */
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

  _persistSync() {
    if (this.memoryOnly) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ version: 1, orders: Object.fromEntries(this.orders) }, null, 2);
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.filePath); // 原子替换
  }

  /** 串行化执行，保证读-改-写不交错 */
  _serial(fn) {
    const run = this._queue.then(() => fn());
    // 即使失败也不阻断后续队列
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  get(outTradeNo) {
    return this.orders.get(outTradeNo) || null;
  }

  /**
   * 创建订单（本地订单为准，用于后续资源校验与幂等）
   */
  create({ outTradeNo, resourceId, amount, payBefore, goodsName }) {
    return this._serial(() => {
      if (this.orders.has(outTradeNo)) {
        throw new Error(`订单号重复：${outTradeNo}`);
      }
      const order = {
        out_trade_no: outTradeNo,
        resource_id: resourceId,
        amount,
        goods_name: goodsName,
        pay_before: payBefore,
        status: STATUS.PENDING,
        trade_no: null,
        created_at: new Date().toISOString(),
        paid_at: null,
        fulfilled_at: null,
      };
      this.orders.set(outTradeNo, order);
      this._persistSync();
      return order;
    });
  }

  /**
   * 标记已支付
   */
  markPaid(outTradeNo, tradeNo) {
    return this._serial(() => {
      const order = this.orders.get(outTradeNo);
      if (!order) return null;
      order.status = STATUS.PAID;
      order.trade_no = tradeNo;
      order.paid_at = order.paid_at || new Date().toISOString();
      this._persistSync();
      return order;
    });
  }

  /**
   * 标记已履约 —— 幂等核心
   *
   * 若订单已处于 FULFILLED，直接返回 alreadyFulfilled=true，
   * 调用方必须据此跳过业务逻辑并避免重复交付/重复上报。
   *
   * @returns {Promise<{order:object|null, alreadyFulfilled:boolean}>}
   */
  markFulfilled(outTradeNo, tradeNo) {
    return this._serial(() => {
      const order = this.orders.get(outTradeNo);
      if (!order) return { order: null, alreadyFulfilled: false };

      if (order.status === STATUS.FULFILLED) {
        return { order, alreadyFulfilled: true };
      }

      order.status = STATUS.FULFILLED;
      order.trade_no = tradeNo || order.trade_no;
      order.fulfilled_at = new Date().toISOString();
      if (!order.paid_at) order.paid_at = order.fulfilled_at;
      this._persistSync();
      return { order, alreadyFulfilled: false };
    });
  }

  /**
   * 记录履约回执上报结果
   *
   * 回执上报失败不应阻止向消费者交付已付费的资源，
   * 但必须留痕以便后续补偿重试（见 README「履约回执补偿」）。
   */
  noteFulfillmentConfirm(outTradeNo, { ok, code, subCode, subMsg }) {
    return this._serial(() => {
      const order = this.orders.get(outTradeNo);
      if (!order) return null;
      order.fulfillment_confirm = {
        ok: Boolean(ok),
        code: code ?? null,
        sub_code: subCode ?? null,
        sub_msg: subMsg ?? null,
        confirmed_at: ok ? new Date().toISOString() : null,
        attempted_at: new Date().toISOString(),
        attempts: (order.fulfillment_confirm?.attempts || 0) + 1,
      };
      this._persistSync();
      return order;
    });
  }

  /** 列出回执未成功上报的订单，供补偿任务使用 */
  listPendingFulfillmentConfirm() {
    const out = [];
    for (const order of this.orders.values()) {
      if (order.status === STATUS.FULFILLED && !order.fulfillment_confirm?.ok) {
        out.push(order);
      }
    }
    return out;
  }

  /** 仅用于测试/运维 */
  size() {
    return this.orders.size;
  }
}

module.exports = { OrderStore, STATUS };
