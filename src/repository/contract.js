'use strict';

/**
 * 订单仓储接口约定（所有实现必须遵守）
 *
 * 为什么必须抽成接口：
 *   402 协议的正确性依赖五个关键控制（清单第五节）——
 *   订单持久化、本地订单匹配、金额一致性、资源防串、幂等履约。
 *   它们属于业务语义，不应与「用文件还是用数据库」耦合。
 *   抽出来之后：单机可用 JSON 文件，多实例换数据库，业务代码零改动。
 *
 * 状态机（两阶段履约）：
 *
 *   PENDING ──生成资源──▶ PENDING_CONFIRM ──回执确认成功──▶ FULFILLED
 *     │                        ▲    │
 *     └──(可选)──▶ PAID ───────┘    └──回执失败：留在 PENDING_CONFIRM，
 *                                        释放认领，可用同一 Payment-Proof 重试
 *
 * 实现必须保证的原子性：
 *   1. create            —— out_trade_no 唯一，重复创建必须失败
 *   2. prepareFulfillment —— 同一订单的 createResource 只被调用一次
 *                            （并发/多实例下也不能重复生成资源）
 *   3. claimFulfillmentConfirm —— 同一订单同一时刻只有一个执行者能上报回执
 *                            （跨实例），租约到期自动可被抢占
 *
 * @typedef {object} Order
 * @property {string} out_trade_no
 * @property {string} resource_id
 * @property {string} amount
 * @property {string} currency
 * @property {string} goods_name
 * @property {string} pay_before
 * @property {'PENDING'|'PAID'|'PENDING_CONFIRM'|'FULFILLED'} status
 * @property {string|null} trade_no
 * @property {string|null} service_result
 * @property {string} created_at
 * @property {string|null} paid_at
 * @property {string|null} fulfilled_at
 * @property {{ok:boolean,code:string|null,sub_code:string|null,sub_msg:string|null,attempts:number}|undefined} fulfillment_confirm
 */

/** 订单状态 */
const STATUS = {
  /** 已下单，待支付 */
  PENDING: 'PENDING',
  /** 已确认支付（可选中间态） */
  PAID: 'PAID',
  /** 资源已生成，履约回执待确认 */
  PENDING_CONFIRM: 'PENDING_CONFIRM',
  /** 履约回执已确认，交易闭环 */
  FULFILLED: 'FULFILLED',
};

const STATUS_VALUES = Object.values(STATUS);

/** 回执认领租约默认时长：超过则视为持有者已崩溃，允许他人抢占 */
const DEFAULT_CONFIRM_LEASE_MS = 30000;

/** 统一的时间表示：ISO 8601 字符串，便于 JSON 与 SQL 两种实现共用 */
function isoNow() {
  return new Date().toISOString();
}

module.exports = { STATUS, STATUS_VALUES, DEFAULT_CONFIRM_LEASE_MS, isoNow };
