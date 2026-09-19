'use strict';

/**
 * 示例业务接口的响应构造（占位实现）
 *
 * 为什么放在 src/ 而不是 examples/：
 *   同一份占位逻辑有两个使用场景 ——
 *     1. examples/business-api.js   独立进程的联调桩
 *     2. src/server.js 挂载的本地路由（让 BUSINESS_API_URL 可以指向本服务）
 *   放在这里避免两处实现漂移。
 *
 * ⚠️ 这是【占位实现】，不是真实业务。上线前必须替换为你自己的业务逻辑。
 */

const crypto = require('node:crypto');

/**
 * 由幂等键确定性推导 pick_token。
 * 同一订单号 → 同一 token；不同订单 → 不同 token。
 * 这样「同一订单重复调用不产生新结果」是可验证的，而不是靠承诺。
 */
function derivePickToken(idempotencyKey) {
  const seed = idempotencyKey || crypto.randomUUID();
  return `pick_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

/**
 * 构造占位业务响应
 *
 * @param {object} args
 * @param {string|null} args.body 买家请求体原文
 * @param {object} [args.query]   买家 query
 * @param {string|null} [args.idempotencyKey] 幂等键（= out_trade_no）
 * @param {string} [args.method]  HTTP 方法
 * @param {string} [args.servedBy] 来源标识，便于区分桩与本服务路由
 * @returns {object}
 */
function buildDemoBusinessResponse({
  body,
  query = {},
  idempotencyKey = null,
  method = 'POST',
  servedBy = 'demo',
}) {
  let parsedBody = null;
  if (body && String(body).trim()) {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      parsedBody = body; // 非 JSON 就原样带出
    }
  }

  return {
    ok: true,
    pick_token: derivePickToken(idempotencyKey),
    out_trade_no: idempotencyKey,
    // 回显买家输入，用于确认透传链路
    echo: { method, query, body: parsedBody },
    served_at: new Date().toISOString(),
    served_by: servedBy,
  };
}

module.exports = { derivePickToken, buildDemoBusinessResponse };
