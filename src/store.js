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
  /** 已下单，待支付 */
  PENDING: 'PENDING',
  /** 已确认支付（可选中间态） */
  PAID: 'PAID',
  /**
   * 资源已生成，履约回执待确认。
   *
   * 这是「两阶段履约」的关键中间态：资源只生成一次并落库，
   * 回执上报失败时订单停在此态，允许用同一份 Payment-Proof 重试上报，
   * 而不会重新生成资源、也不会丢失回执。
   */
  PENDING_CONFIRM: 'PENDING_CONFIRM',
  /** 履约回执已确认，交易闭环 */
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
    /** 每订单互斥链，保证同一订单的「履约 + 回执」不会并发重复执行 */
    this._orderLocks = new Map();
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
   * 同一订单的互斥执行（进程内）。
   *
   * 为什么需要：两阶段履约下，并发携带同一 Payment-Proof 的请求都会走到
   * 「上报履约回执」这一步，若不做互斥就会对同一 trade_no 重复上报。
   * 后到的请求会在前一个完成后才进入临界区，此时订单已是 FULFILLED，
   * 于是直接复用已落库资源、不再重复上报。
   *
   * ⚠️ 这是【进程内】锁。多实例部署时无法互斥，必须改用分布式锁，
   *    并以数据库唯一约束作为幂等的最终保证（见 README「生产化建议」）。
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  withOrderLock(key, fn) {
    const prev = this._orderLocks.get(key) || Promise.resolve();
    const run = prev.then(() => fn());

    // 链尾（吞掉异常，避免一次失败阻断后续排队者）
    const tail = run.then(() => undefined, () => undefined);
    this._orderLocks.set(key, tail);
    tail.then(() => {
      // 只有当自己仍是链尾时才清理，避免误删后来者
      if (this._orderLocks.get(key) === tail) this._orderLocks.delete(key);
    });

    return run;
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
        /** 已生成的业务资源（两阶段履约复用，避免重复生成） */
        service_result: null,
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
   * 两阶段履约 · 第一步：原子占位并【只生成一次】资源。
   *
   * 为什么必须是两阶段：
   *   官方参考实现要求「履约回执上报失败时不得返回成功交付，
   *   且允许用同一 Payment-Proof 重试上报」。若像单阶段那样在生成资源时
   *   就直接置为 FULFILLED，回执失败后就再也没有重试机会 ——
   *   重试会命中「已履约」分支而永远不再补发回执。
   *
   * 状态转移：
   *   PENDING/PAID        → 生成资源 → PENDING_CONFIRM（返回新生成的资源）
   *   PENDING_CONFIRM     → 复用已落库资源 → PENDING_CONFIRM（不重新生成）
   *   FULFILLED           → 复用已落库资源 → FULFILLED（已闭环）
   *
   * 由于生成与状态转移在同一串行区内完成，并发请求也只会生成一次资源。
   *
   * @param {object} args
   * @param {string} args.outTradeNo
   * @param {string} [args.tradeNo]
   * @param {() => string} args.createResource 资源生成函数（仅在需要时调用一次）
   * @returns {Promise<{order:object|null, state:string|null, serviceResult:string|null, alreadyFulfilled:boolean}>}
   */
  prepareFulfillment({ outTradeNo, tradeNo, createResource }) {
    return this._serial(() => {
      const order = this.orders.get(outTradeNo);
      if (!order) {
        return { order: null, state: null, serviceResult: null, alreadyFulfilled: false };
      }

      // 已闭环：直接复用
      if (order.status === STATUS.FULFILLED) {
        return {
          order,
          state: STATUS.FULFILLED,
          serviceResult: order.service_result ?? null,
          alreadyFulfilled: true,
        };
      }

      // 资源已生成但回执未确认：复用，绝不重新生成
      if (order.status === STATUS.PENDING_CONFIRM) {
        return {
          order,
          state: STATUS.PENDING_CONFIRM,
          serviceResult: order.service_result ?? null,
          alreadyFulfilled: false,
        };
      }

      // 首次履约：生成资源并落库
      const serviceResult = createResource();
      order.service_result = serviceResult;
      order.status = STATUS.PENDING_CONFIRM;
      order.trade_no = tradeNo || order.trade_no;
      if (!order.paid_at) order.paid_at = new Date().toISOString();
      this._persistSync();

      return { order, state: STATUS.PENDING_CONFIRM, serviceResult, alreadyFulfilled: false };
    });
  }

  /**
   * 两阶段履约 · 第二步：回执确认成功后闭环。
   *
   * 只有支付宝确认收到履约回执后才调用，确保 FULFILLED 一定意味着回执已上报。
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
   * 回执上报失败时订单停留在 PENDING_CONFIRM，可用同一份 Payment-Proof
   * 重试上报（会复用已生成资源，不会重复生成）。
   * 此方法仅留痕，便于运维观察与补偿任务筛选。
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

  /**
   * 列出回执尚未确认的订单，供补偿任务使用。
   *
   * 判据是订单停在 PENDING_CONFIRM（资源已生成、回执未闭环），
   * 而不是「FULFILLED 但 confirm 失败」—— 后者在新语义下不应存在。
   */
  listPendingFulfillmentConfirm() {
    const out = [];
    for (const order of this.orders.values()) {
      const stuckAtConfirm = order.status === STATUS.PENDING_CONFIRM;
      const closedButUnconfirmed = order.status === STATUS.FULFILLED && !order.fulfillment_confirm?.ok;
      if (stuckAtConfirm || closedButUnconfirmed) {
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
