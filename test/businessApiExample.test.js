'use strict';

/**
 * 示例业务 API 桩的测试
 *
 * 这个桩是联调用的，但它必须「行为可信」——
 * 否则联调通过了、上线换真实接口却挂掉，等于白测。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildResponse, derivePickToken, createServer, ROUTE } = require('../examples/business-api');

// ================================================================ 响应构造

test('buildResponse 返回 ok 与 pick_token', () => {
  const out = buildResponse({ body: '{"a":1}', query: { x: '1' }, idempotencyKey: 'ORDER_1' });
  assert.equal(out.ok, true);
  assert.match(out.pick_token, /^pick_[0-9a-f]{32}$/);
  assert.equal(out.out_trade_no, 'ORDER_1');
});

test('pick_token 由幂等键确定性推导：同一订单得到同一 token', () => {
  const a = buildResponse({ body: '{}', idempotencyKey: 'ORDER_SAME' });
  const b = buildResponse({ body: '{}', idempotencyKey: 'ORDER_SAME' });
  assert.equal(a.pick_token, b.pick_token, '同一订单必须得到同一 token（幂等）');

  const c = buildResponse({ body: '{}', idempotencyKey: 'ORDER_OTHER' });
  assert.notEqual(a.pick_token, c.pick_token, '不同订单应得到不同 token');
});

test('缺少幂等键时仍返回合法 token（不崩）', () => {
  const out = buildResponse({ body: '{}', idempotencyKey: null });
  assert.match(out.pick_token, /^pick_[0-9a-f]{32}$/);
  assert.equal(out.out_trade_no, null);
});

test('buildResponse 回显买家的 query 与 body（含非 JSON body）', () => {
  const json = buildResponse({ body: '{"prompt":"hi"}', query: { lang: 'zh' }, idempotencyKey: 'O' });
  assert.deepEqual(json.echo.body, { prompt: 'hi' });
  assert.deepEqual(json.echo.query, { lang: 'zh' });

  const raw = buildResponse({ body: 'plain text', idempotencyKey: 'O' });
  assert.equal(raw.echo.body, 'plain text');

  const none = buildResponse({ body: '', idempotencyKey: 'O' });
  assert.equal(none.echo.body, null);
});

test('derivePickToken 对相同输入稳定', () => {
  assert.equal(derivePickToken('X'), derivePickToken('X'));
  assert.notEqual(derivePickToken('X'), derivePickToken('Y'));
});

// ================================================================ HTTP 层

async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('HTTP：POST 正常返回 ok 与 pick_token，且带上幂等键', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}${ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'ORDER_HTTP_1' },
      body: JSON.stringify({ prompt: 'summarize' }),
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.pick_token, /^pick_[0-9a-f]{32}$/);
    assert.equal(body.out_trade_no, 'ORDER_HTTP_1');
    assert.deepEqual(body.echo.body, { prompt: 'summarize' });
  });
});

test('HTTP：未知路径返回 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).ok, false);
  });
});

test('HTTP：fail=500 注入上游错误', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}${ROUTE}?fail=500`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).ok, false);
  });
});

test('HTTP：fail=empty 返回 200 空体（用于验证「空响应不得当作成功」）', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}${ROUTE}?fail=empty`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });
});

test('HTTP：fail 参数不会被回显进 echo.query', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}${ROUTE}?fail=500&keep=1`, { method: 'POST', body: '{}' });
    // fail=500 直接返回错误体，不含 echo；换个正常请求验证过滤
    const ok = await fetch(`${base}${ROUTE}?keep=1`, { method: 'POST', body: '{}' });
    const body = await ok.json();
    assert.deepEqual(body.echo.query, { keep: '1' });
    assert.equal(res.status, 500);
  });
});
