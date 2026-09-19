'use strict';

/**
 * 业务资源 provider 与请求指纹测试
 *
 * 「API 按次付费」的两个核心点在这里验证：
 *   1. 买家的请求真的被正确转发给业务 API（含幂等键、鉴权头，且不泄露支付凭证）
 *   2. 请求指纹能把「被收费的请求」与「实际执行的请求」绑定，
 *      防止低价付款 + 高价调用
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  fingerprint,
  stableStringify,
  canonicalBody,
  canonicalQuery,
} = require('../src/requestContext');
const { createResourceProvider, createApiProvider, createStaticProvider } = require('../src/resource');

// ================================================================ 请求指纹

test('stableStringify 对键顺序不敏感', () => {
  assert.equal(
    stableStringify({ b: 1, a: 2 }),
    stableStringify({ a: 2, b: 1 }),
  );
});

test('stableStringify 保持数组顺序（数组语义有序）', () => {
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

test('canonicalBody 对 JSON 键顺序不敏感', () => {
  assert.equal(
    canonicalBody('{"a":1,"b":2}'),
    canonicalBody('{"b":2,"a":1}'),
  );
});

test('canonicalBody 对非 JSON 原文按原样处理', () => {
  assert.equal(canonicalBody('plain text'), 'plain text');
  assert.equal(canonicalBody(''), '');
  assert.equal(canonicalBody(null), '');
});

test('canonicalQuery 按键排序', () => {
  assert.equal(canonicalQuery({ b: '2', a: '1' }), 'a=1&b=2');
});

test('指纹：键顺序不同的同一请求得到同一指纹', () => {
  const a = fingerprint({ method: 'POST', path: '/r', query: { b: '2', a: '1' }, body: '{"x":1,"y":2}' });
  const b = fingerprint({ method: 'POST', path: '/r', query: { a: '1', b: '2' }, body: '{"y":2,"x":1}' });
  assert.equal(a, b);
});

test('指纹：method / path / query / body 任一变化都会改变指纹', () => {
  const baseReq = { method: 'POST', path: '/r', query: { a: '1' }, body: '{"x":1}' };
  const base = fingerprint(baseReq);

  assert.notEqual(base, fingerprint({ ...baseReq, method: 'GET' }));
  assert.notEqual(base, fingerprint({ ...baseReq, path: '/other' }));
  assert.notEqual(base, fingerprint({ ...baseReq, query: { a: '2' } }));
  assert.notEqual(base, fingerprint({ ...baseReq, query: { a: '1', b: '2' } }));
  // 这正是「低价付款、高价调用」要拦住的场景
  assert.notEqual(base, fingerprint({ ...baseReq, body: '{"x":1,"expensive":true}' }));
});

test('指纹：大小写不敏感的 method 归一化', () => {
  assert.equal(
    fingerprint({ method: 'post', path: '/r' }),
    fingerprint({ method: 'POST', path: '/r' }),
  );
});

// ================================================================ static provider

test('static provider 返回非空且可归属的内容', async () => {
  const provider = createStaticProvider();
  const out = await provider({ resourceId: '/r', outTradeNo: 'O1', tradeNo: 'T1' });
  assert.ok(out && out.trim().length > 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.resource_id, '/r');
  assert.equal(parsed.out_trade_no, 'O1');
  assert.equal(parsed.trade_no, 'T1');
});

// ================================================================ api provider

/** 起一个本地「业务 API」替身，记录收到的请求 */
async function withUpstream(handler, fn) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    return await fn({ baseUrl: `http://127.0.0.1:${port}`, received });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function apiConfig(baseUrl, overrides = {}) {
  return {
    businessApiUrl: `${baseUrl}/business`,
    businessApiMethod: 'POST',
    businessApiTimeoutMs: 3000,
    businessApiAuthHeader: 'Authorization',
    businessApiAuthValue: 'Bearer TEST_TOKEN',
    businessApiIdempotencyHeader: 'Idempotency-Key',
    businessApiPassQuery: true,
    resourceWrapResponse: true,
    resourceServiceType: 'API_CALL',
    ...overrides,
  };
}

test('api provider 把买家的 method/query/body 转发给业务 API', async () => {
  await withUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answer: 42 }));
  }, async ({ baseUrl, received }) => {
    const provider = createApiProvider(apiConfig(baseUrl));
    const out = await provider({
      resourceId: '/r',
      outTradeNo: 'ORDER_1',
      tradeNo: 'T1',
      request: {
        method: 'POST',
        path: '/r',
        query: { lang: 'zh', page: '2' },
        body: '{"prompt":"hello"}',
        headers: { 'content-type': 'application/json' },
      },
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.match(received[0].url, /lang=zh/);
    assert.match(received[0].url, /page=2/);
    assert.equal(received[0].body, '{"prompt":"hello"}');

    const parsed = JSON.parse(out);
    assert.equal(parsed.status, 'success');
    assert.equal(parsed.resource_id, '/r');
    assert.equal(parsed.out_trade_no, 'ORDER_1');
    assert.deepEqual(parsed.data, { answer: 42 });
  });
});

test('api provider 携带鉴权头与幂等键（幂等键 = out_trade_no）', async () => {
  await withUpstream((req, res) => { res.writeHead(200); res.end('{"ok":true}'); },
    async ({ baseUrl, received }) => {
      const provider = createApiProvider(apiConfig(baseUrl));
      await provider({ resourceId: '/r', outTradeNo: 'ORDER_IDEM', tradeNo: 'T', request: { method: 'POST', body: '{}' } });

      assert.equal(received[0].headers.authorization, 'Bearer TEST_TOKEN');
      assert.equal(received[0].headers['idempotency-key'], 'ORDER_IDEM');
    });
});

test('api provider 绝不把支付相关头转发给业务 API', async () => {
  await withUpstream((req, res) => { res.writeHead(200); res.end('{"ok":1}'); },
    async ({ baseUrl, received }) => {
      const provider = createApiProvider(apiConfig(baseUrl));
      await provider({
        resourceId: '/r',
        outTradeNo: 'O',
        tradeNo: 'T',
        request: {
          method: 'POST',
          body: '{}',
          // 即使上游上下文带了这些，也不应出现在转发头里
          headers: {
            'content-type': 'application/json',
            'payment-proof': 'SECRET_PROOF',
            'payment-validation': 'SECRET_VALIDATION',
          },
        },
      });

      const h = received[0].headers;
      assert.equal(h['payment-proof'], undefined, '不得转发 Payment-Proof');
      assert.equal(h['payment-validation'], undefined, '不得转发 Payment-Validation');
      assert.equal(h['content-type'], 'application/json');
    });
});

test('api provider：上游非 2xx 必须抛错（订单保持可重试）', async () => {
  await withUpstream((req, res) => { res.writeHead(500); res.end('upstream boom'); },
    async ({ baseUrl }) => {
      const provider = createApiProvider(apiConfig(baseUrl));
      await assert.rejects(
        () => provider({ resourceId: '/r', outTradeNo: 'O', tradeNo: 'T', request: { method: 'POST', body: '{}' } }),
        /业务 API 返回 500/,
      );
    });
});

test('api provider：上游返回空内容必须抛错（不得当作成功交付）', async () => {
  await withUpstream((req, res) => { res.writeHead(200); res.end(''); },
    async ({ baseUrl }) => {
      const provider = createApiProvider(apiConfig(baseUrl));
      await assert.rejects(
        () => provider({ resourceId: '/r', outTradeNo: 'O', tradeNo: 'T', request: { method: 'POST', body: '{}' } }),
        /空内容/,
      );
    });
});

test('api provider：超时抛错', async () => {
  await withUpstream((req, res) => { /* 故意不响应 */ },
    async ({ baseUrl }) => {
      const provider = createApiProvider(apiConfig(baseUrl, { businessApiTimeoutMs: 200 }));
      await assert.rejects(
        () => provider({ resourceId: '/r', outTradeNo: 'O', tradeNo: 'T', request: { method: 'POST', body: '{}' } }),
        /超时/,
      );
    });
});

test('api provider：RESOURCE_WRAP_RESPONSE=false 时返回上游原文', async () => {
  await withUpstream((req, res) => { res.writeHead(200); res.end('RAW_TEXT_RESULT'); },
    async ({ baseUrl }) => {
      const provider = createApiProvider(apiConfig(baseUrl, { resourceWrapResponse: false }));
      const out = await provider({ resourceId: '/r', outTradeNo: 'O', tradeNo: 'T', request: { method: 'POST', body: '{}' } });
      assert.equal(out, 'RAW_TEXT_RESULT');
    });
});

test('api provider：非 JSON 上游响应也能包裹（data 退化为文本）', async () => {
  await withUpstream((req, res) => { res.writeHead(200); res.end('not json at all'); },
    async ({ baseUrl }) => {
      const provider = createApiProvider(apiConfig(baseUrl));
      const out = await provider({ resourceId: '/r', outTradeNo: 'O', tradeNo: 'T', request: { method: 'POST', body: '{}' } });
      const parsed = JSON.parse(out);
      assert.equal(parsed.data, 'not json at all');
    });
});

test('api provider：GET 不发送请求体', async () => {
  await withUpstream((req, res) => { res.writeHead(200); res.end('{"ok":1}'); },
    async ({ baseUrl, received }) => {
      const provider = createApiProvider(apiConfig(baseUrl, { businessApiMethod: 'GET' }));
      await provider({ resourceId: '/r', outTradeNo: 'O', tradeNo: 'T', request: { method: 'GET', query: { q: 'x' }, body: null } });
      assert.equal(received[0].method, 'GET');
      assert.equal(received[0].body, '');
    });
});

// ================================================================ 工厂

test('createResourceProvider 默认返回 static 实现', async () => {
  const provider = createResourceProvider({ resourceProvider: 'static' });
  assert.ok((await provider({ resourceId: '/r', outTradeNo: 'O', tradeNo: 'T' })).length > 0);
});

test('createResourceProvider：api 未配 URL 时抛错', () => {
  assert.throws(
    () => createResourceProvider({ resourceProvider: 'api', businessApiUrl: null }),
    /BUSINESS_API_URL/,
  );
});
