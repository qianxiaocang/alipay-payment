'use strict';

/**
 * 买家请求上下文 —— 供「API 按次付费」把请求透传给业务 API
 *
 * 为什么需要这一层：
 *   402 协议的时序是「先请求（被拒 402）→ 付款 → 再请求（带凭证）」，
 *   买家真正的业务输入（POST body / query）在**第二次请求**上。
 *   因此资源生成必须能拿到这次请求的内容，否则「按次付费的 API」
 *   无从知道该拿什么去调后端。
 *
 * 同时这里提供【请求指纹】，用于把「被收费的那次请求」和「实际执行的请求」
 * 绑定起来 —— 详见 fingerprint() 的安全说明。
 */

const crypto = require('crypto');

/**
 * 稳定的 JSON 序列化：对象键排序，保证同一语义内容得到同一字符串。
 * 用于指纹计算，避免因键顺序不同导致误判。
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 规范化 body：能按 JSON 解析就按稳定序列化，否则用原始字符串。
 */
function canonicalBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return stableStringify(JSON.parse(trimmed));
      } catch {
        return body;
      }
    }
    return body;
  }
  if (Buffer.isBuffer(body)) return canonicalBody(body.toString('utf8'));
  if (typeof body === 'object') return stableStringify(body);
  return String(body);
}

/**
 * 规范化 query：按键排序，值按字符串处理。
 */
function canonicalQuery(query) {
  if (!query || typeof query !== 'object') return '';
  return Object.keys(query)
    .sort()
    .map((k) => {
      const v = query[k];
      const value = Array.isArray(v) ? v.join(',') : v === undefined || v === null ? '' : String(v);
      return `${encodeURIComponent(k)}=${encodeURIComponent(value)}`;
    })
    .join('&');
}

/**
 * 计算请求指纹。
 *
 * ⚠️ 安全用途（重要）：
 *   402 协议本身**没有**把请求载荷写进 Payment-Needed，也没有字段能承载它的哈希。
 *   这意味着如果不做绑定，攻击者可以：
 *     1. 用一个便宜/无害的请求拿到 402，付款 0.01
 *     2. 带着同一份 Payment-Proof 重放一个**完全不同、成本高得多**的请求
 *   服务端会因为凭证有效而放行，等于用低价买了高价调用。
 *
 *   本实现的对策：在返回 402 时把当时请求的指纹存进订单，二次请求时重新计算
 *   并比对。指纹不匹配即拒绝。这是**服务端侧绑定**，不依赖协议是否支持。
 *
 * 只纳入 method / path / query / body —— 不纳入 headers，避免买家 CLI 重放时
 * 因 header 顺序、UA 等无关差异产生误判。
 */
function fingerprint({ method, path, query, body }) {
  const canonical = [
    String(method || 'GET').toUpperCase(),
    String(path || ''),
    canonicalQuery(query),
    canonicalBody(body),
  ].join('\n');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * 从 express req 构建上下文。
 *
 * `body` 统一为字符串（或 null），这样：
 *   - 指纹计算稳定（不受 Buffer/对象差异影响）
 *   - 转发给业务 API 时可直接作为请求体，不会被 JSON.stringify 变成 Buffer 字面量
 *
 * 只保留业务需要且不敏感的字段；**不含**任何支付相关头。
 *
 * @param {import('express').Request} req
 * @returns {{method:string, path:string, query:object, body:string|null, rawBody:string|null, headers:object}}
 */
function fromExpressRequest(req) {
  let rawBody = null;

  if (req.rawBody) {
    rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody);
  } else if (Buffer.isBuffer(req.body)) {
    rawBody = req.body.toString('utf8');
  } else if (typeof req.body === 'string') {
    rawBody = req.body;
  } else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    rawBody = JSON.stringify(req.body);
  }

  return {
    method: req.method,
    path: req.path,
    query: req.query || {},
    body: rawBody,
    rawBody,
    headers: {
      'content-type': req.get('content-type') || null,
      accept: req.get('accept') || null,
    },
  };
}

module.exports = {
  stableStringify,
  canonicalBody,
  canonicalQuery,
  fingerprint,
  fromExpressRequest,
};
