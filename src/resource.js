'use strict';

/**
 * 业务资源生成 —— 这是你接入自己业务逻辑的地方
 *
 * 官方示例把「生成资源」写成了固定字符串。这里保留同样的返回结构，
 * 但把实现抽成可替换的函数，便于你替换为真实的付费内容产出。
 *
 * 返回结构（与文档 4.3 响应体示例一致）：
 *   content 为 JSON 字符串
 */

const { formatIso8601WithTimezone } = require('./signing');

/**
 * 默认资源生成器：返回一段占位内容。
 *
 * ⚠️ 请替换为你自己的业务实现（例如真正调用大模型生成内容、返回数据文件等）。
 *    注意必须保证幂等：同一订单重复调用不应产生副作用或二次计费。
 *
 * @param {{ resourceId: string, outTradeNo: string, tradeNo: string }} ctx
 * @returns {string} JSON 字符串
 */
function generateDefaultResource({ resourceId, outTradeNo, tradeNo }) {
  return JSON.stringify({
    status: 'success',
    service_type: 'AI_CONTENT_GENERATION',
    resource_id: resourceId,
    out_trade_no: outTradeNo,
    trade_no: tradeNo,
    content: '这是 AI 生成的内容示例，请替换为你的真实付费内容',
    generated_at: formatIso8601WithTimezone(new Date()),
  });
}

module.exports = { generateDefaultResource };
