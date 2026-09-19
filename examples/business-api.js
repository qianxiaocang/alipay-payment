#!/usr/bin/env node
'use strict';

/**
 * 示例业务 API —— 供本地/联调把 402 链路端到端跑通
 *
 * 它模拟「买家付费后你要调用的那个内部接口」：
 *
 *   POST http://127.0.0.1:4000/paid-api
 *   → { "ok": true, "pick_token": "...", ... }
 *
 * 启动：
 *   npm run business-api
 *
 * 在主服务 .env 中配置：
 *   RESOURCE_PROVIDER=api
 *   BUSINESS_API_URL=http://127.0.0.1:4000/paid-api
 *   RESOURCE_WRAP_RESPONSE=false     # 让业务 API 原文直接作为 content
 *
 * ⚠️ 这是【联调用桩】，不是生产实现。上线前请换成你自己的业务接口。
 *
 * 设计要点（为什么这样写）：
 *   1. 回显买家的请求体与 query —— 便于确认请求真的被透传过来了
 *   2. pick_token 由幂等键（Idempotency-Key = out_trade_no）确定性推导 ——
 *      同一订单重复调用得到同一个 token，直观体现幂等键的作用
 *   3. 支持用 query 触发失败，便于验证「上游失败时订单保持可重试」：
 *        ?fail=500    → 返回 500
 *        ?fail=empty  → 返回 200 但空体
 *        ?fail=slow   → 延迟 5 秒（用于验证超时）
 */

const http = require('node:http');
const { derivePickToken, buildDemoBusinessResponse } = require('../src/demoBusiness');

const PORT = Number(process.env.BUSINESS_API_PORT || 4000);
const HOST = process.env.BUSINESS_API_HOST || '127.0.0.1';
const ROUTE = process.env.BUSINESS_API_ROUTE || '/paid-api';

const SERVED_BY = 'examples/business-api.js（联调桩，上线前请替换）';

/**
 * 构造业务响应（导出以便单测）
 *
 * 实际逻辑复用 src/demoBusiness.js —— 与「挂在本服务上的 /action 路由」
 * 共用同一份占位实现，避免两处漂移。
 *
 * @param {object} args
 * @param {string|null} args.body 买家请求体原文
 * @param {object} args.query    买家 query
 * @param {string|null} args.idempotencyKey 幂等键（= out_trade_no）
 * @returns {object}
 */
function buildResponse({ body, query = {}, idempotencyKey = null }) {
  return buildDemoBusinessResponse({ body, query, idempotencyKey, method: 'POST', servedBy: SERVED_BY });
}

// ---------------------------------------------------------------- HTTP 层

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname !== ROUTE) {
      sendJson(res, 404, { ok: false, message: `未知路径，请调用 ${ROUTE}` });
      return;
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const idempotencyKey = req.headers['idempotency-key'] || null;
      const fail = url.searchParams.get('fail');

      console.log(
        '[business-api] %s %s | 幂等键=%s | body=%d 字节',
        req.method,
        url.pathname + url.search,
        idempotencyKey || '(无)',
        Buffer.byteLength(body),
      );

      // 失败注入：仅用于验证「上游失败 → 订单保持可重试」
      if (fail === '500') {
        sendJson(res, 500, { ok: false, message: '注入的 500 错误' });
        return;
      }
      if (fail === 'empty') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('');
        return;
      }
      if (fail === 'slow') {
        setTimeout(() => sendJson(res, 200, { ok: true, note: 'slow' }), 5000);
        return;
      }

      const query = Object.fromEntries(url.searchParams.entries());
      delete query.fail;

      if (req.method !== 'POST' && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, message: '仅支持 GET / POST' });
        return;
      }

      sendJson(res, 200, buildResponse({ body, query, idempotencyKey }));
    });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`[business-api] 联调桩已启动：http://${HOST}:${PORT}${ROUTE}`);
    console.log('[business-api] 在主服务 .env 中配置：');
    console.log(`[business-api]   RESOURCE_PROVIDER=api`);
    console.log(`[business-api]   BUSINESS_API_URL=http://${HOST}:${PORT}${ROUTE}`);
    console.log(`[business-api]   RESOURCE_WRAP_RESPONSE=false`);
    console.log('[business-api] ⚠️  这是占位桩，上线前必须替换为真实业务接口');
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { buildResponse, derivePickToken, createServer, ROUTE, PORT };
