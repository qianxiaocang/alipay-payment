'use strict';

/**
 * 业务资源生成 —— 本文件是「你卖的东西」的实现
 *
 * 在 402 协议里，`resource_id` 是「卖的是什么」的身份标识，
 * 而本文件决定「买家付完钱之后实际拿到什么」。
 *
 * 本仓库面向「API 按次付费」场景，提供两种 provider：
 *
 *   static —— 返回占位内容，仅用于跑通链路（默认）
 *   api    —— 把买家的请求转发给你自己的业务 API，把响应作为付费内容返回
 *
 * ⚠️ 为什么必须能拿到买家请求：
 *   402 的时序是「先请求（被拒 402）→ 付款 → 再请求（带凭证）」。
 *   买家真正的业务输入（POST body / query）出现在**第二次请求**上，
 *   所以资源生成必须收到这次请求的内容，否则「按次付费的 API」不知道该拿什么去调后端。
 *
 * ⚠️ 幂等：
 *   本函数对同一订单**只会被调用一次**（仓储层的生成租约保证），
 *   同时我们仍会把 out_trade_no 作为幂等键传给业务 API，
 *   以防跨实例竞争或人工重试导致上游被重复调用。
 */

const { formatIso8601WithTimezone } = require('./signing');

// ---------------------------------------------------------------- static

/**
 * 占位 provider：跑通链路用，不含真实业务。
 */
function createStaticProvider() {
  return async function staticResource({ resourceId, outTradeNo, tradeNo }) {
    return JSON.stringify({
      status: 'success',
      service_type: 'AI_CONTENT_GENERATION',
      resource_id: resourceId,
      out_trade_no: outTradeNo,
      trade_no: tradeNo,
      content: '这是占位内容。请设置 RESOURCE_PROVIDER=api 并配置 BUSINESS_API_URL 接入真实业务。',
      generated_at: formatIso8601WithTimezone(new Date()),
    });
  };
}

// ---------------------------------------------------------------- api

/**
 * 业务 API 代理 provider
 *
 * 行为：
 *   1. 把买家的 method / query / body 转发到 BUSINESS_API_URL
 *   2. 带上配置的鉴权头 + 幂等键（out_trade_no）
 *   3. 上游非 2xx 或超时 → 抛异常（订单留在可重试态，不上报回执）
 *   4. 默认把上游响应包一层可归属的元数据后返回；可用 RESOURCE_WRAP_RESPONSE=false 关闭
 *
 * 安全约定：
 *   - **不转发** Payment-Proof / Payment-Validation 等支付头给业务 API
 *   - 只转发 content-type / accept（业务需要的最小集合）
 */
function createApiProvider(config) {
  const {
    businessApiUrl,
    businessApiMethod,
    businessApiTimeoutMs,
    businessApiAuthHeader,
    businessApiAuthValue,
    businessApiIdempotencyHeader,
    businessApiPassQuery,
    resourceWrapResponse,
    resourceServiceType,
  } = config;

  return async function apiResource({ resourceId, outTradeNo, tradeNo, request }) {
    const method = (businessApiMethod || 'POST').toUpperCase();

    // 组装目标地址
    let url = businessApiUrl;
    if (businessApiPassQuery && request && request.query && Object.keys(request.query).length) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(request.query)) {
        if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
        else if (v !== undefined && v !== null) qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }

    // 只转发业务必要请求头，绝不转发支付凭证
    const headers = { accept: 'application/json' };
    if (request && request.headers && request.headers['content-type']) {
      headers['content-type'] = request.headers['content-type'];
    } else if (['POST', 'PUT', 'PATCH'].includes(method)) {
      headers['content-type'] = 'application/json';
    }
    if (businessApiAuthHeader && businessApiAuthValue) {
      headers[businessApiAuthHeader] = businessApiAuthValue;
    }
    if (businessApiIdempotencyHeader) {
      headers[businessApiIdempotencyHeader] = outTradeNo;
    }

    const init = { method, headers, signal: AbortSignal.timeout(businessApiTimeoutMs) };
    if (!['GET', 'HEAD'].includes(method) && request && request.body !== undefined && request.body !== null) {
      init.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    }

    let upstream;
    try {
      upstream = await fetch(url, init);
    } catch (err) {
      const reason = err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `业务 API 超时（${businessApiTimeoutMs}ms）`
        : `业务 API 调用失败：${err.message}`;
      throw new Error(reason);
    }

    const text = await upstream.text();

    if (!upstream.ok) {
      // 上游失败必须抛出：让订单保持可重试，且不得上报履约回执
      throw new Error(`业务 API 返回 ${upstream.status}：${text.slice(0, 300)}`);
    }

    if (!text || !text.trim()) {
      // 清单要求「非空可归属资源」，空响应不得当作成功
      throw new Error('业务 API 返回空内容，无法作为付费资源交付');
    }

    if (!resourceWrapResponse) return text;

    // 包裹可归属元数据：买家/对账方据此确认这就是其付费买到的资源
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    return JSON.stringify({
      status: 'success',
      service_type: resourceServiceType,
      resource_id: resourceId,
      out_trade_no: outTradeNo,
      trade_no: tradeNo,
      upstream_status: upstream.status,
      data: parsed !== null ? parsed : text,
      generated_at: formatIso8601WithTimezone(new Date()),
    });
  };
}

// ---------------------------------------------------------------- 工厂

/**
 * @param {object} config loadConfig() 的返回值
 * @returns {(ctx:{resourceId:string,outTradeNo:string,tradeNo:string,request:object})=>Promise<string>}
 */
function createResourceProvider(config) {
  if (config.resourceProvider === 'api') {
    if (!config.businessApiUrl) {
      throw new Error('RESOURCE_PROVIDER=api 时必须配置 BUSINESS_API_URL');
    }
    return createApiProvider(config);
  }
  return createStaticProvider();
}

module.exports = { createResourceProvider, createStaticProvider, createApiProvider };
