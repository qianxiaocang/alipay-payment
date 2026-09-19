'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, redact, createLogger } = require('../src/server');
const { JsonFileOrderRepository } = require('../src/repository');
const { makeConfig, makeProofHeader, FakeSdk } = require('./helpers');
const { base64UrlDecode } = require('../src/signing');

/** 启动一个临时服务器，返回 baseUrl 与关闭函数 */
async function withServer(fn, { configOverrides } = {}) {
  const config = makeConfig(configOverrides);
  const store = new JsonFileOrderRepository({ filePath: ':memory:' });
  await store.init();
  const sdk = new FakeSdk();

  const app = createApp({
    config,
    sdk,
    repository: store,
    logger: { info() {}, warn() {}, error() {} },
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    return await fn({ baseUrl: `http://127.0.0.1:${port}`, config, sdk, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('HTTP：首次请求返回 402 与 Payment-Needed 头', async () => {
  await withServer(async ({ baseUrl, config }) => {
    const res = await fetch(`${baseUrl}${config.resourcePath}`);

    assert.equal(res.status, 402);
    const header = res.headers.get('Payment-Needed');
    assert.ok(header, '应携带 Payment-Needed 响应头');

    const payload = JSON.parse(base64UrlDecode(header));
    assert.equal(payload.protocol.seller_sign_type, 'RSA2');

    const body = await res.json();
    assert.equal(body.code, 'Payment-Needed');
    assert.equal(body.amount, '0.01');
  });
});

test('HTTP：带凭证的完整链路返回 200 与 Payment-Validation 头', async () => {
  await withServer(async ({ baseUrl, config, sdk, store }) => {
    // 首次请求拿订单号
    const first = await fetch(`${baseUrl}${config.resourcePath}`);
    const firstBody = await first.json();

    sdk.verifyResponse = {
      code: '10000',
      msg: 'Success',
      active: true,
      trade_no: '2026041522001401234567890',
      out_trade_no: firstBody.out_trade_no,
      resource_id: config.resourcePath,
      amount: '0.01',
    };

    const res = await fetch(`${baseUrl}${config.resourcePath}`, {
      headers: { 'Payment-Proof': makeProofHeader() },
    });

    assert.equal(res.status, 200);
    const validation = res.headers.get('Payment-Validation');
    assert.ok(validation, '应携带 Payment-Validation 响应头');
    const pv = JSON.parse(base64UrlDecode(validation));
    assert.equal(pv.validated, true);
    assert.equal(pv.out_trade_no, firstBody.out_trade_no);

    const body = await res.json();
    assert.equal(body.already_fulfilled, false);
    assert.ok(body.content, '应返回资源内容');
    assert.equal((await store.get(firstBody.out_trade_no)).status, 'FULFILLED');
  });
});

test('HTTP：健康检查', async () => {
  await withServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.orders, 0);
  });
});

test('HTTP：未知路径返回 404 JSON', async () => {
  await withServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'NOT_FOUND');
  });
});

test('HTTP：错误响应不泄露内部细节', async () => {
  await withServer(async ({ baseUrl, config, sdk }) => {
    const first = await fetch(`${baseUrl}${config.resourcePath}`);
    const firstBody = await first.json();

    // 让校验接口抛出一个含敏感字样的异常
    sdk.verifyResponse = new Error('private key MIIEvQIBADANBgkq leaked in message');

    const res = await fetch(`${baseUrl}${config.resourcePath}`, {
      headers: { 'Payment-Proof': makeProofHeader() },
    });

    assert.equal(res.status, 500);
    const text = JSON.stringify(await res.json());
    assert.ok(!text.includes('MIIEvQIBADANBgkq'), '响应体不得回显底层异常内容');
    assert.ok(!/private key/i.test(text));
    assert.equal(JSON.parse(text).code, 'VERIFY_FAILED');
    assert.ok(firstBody.out_trade_no);
  });
});

test('HTTP：并发重复凭证只履约一次', async () => {
  await withServer(async ({ baseUrl, config, sdk }) => {
    const first = await fetch(`${baseUrl}${config.resourcePath}`);
    const firstBody = await first.json();

    sdk.verifyResponse = {
      code: '10000',
      active: true,
      trade_no: 'T1',
      out_trade_no: firstBody.out_trade_no,
      resource_id: config.resourcePath,
      amount: '0.01',
    };

    const header = makeProofHeader();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${baseUrl}${config.resourcePath}`, { headers: { 'Payment-Proof': header } }),
      ),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));

    assert.equal(bodies.filter((b) => b.already_fulfilled === false).length, 1);
    assert.equal(bodies.filter((b) => b.already_fulfilled === true).length, 4);
    assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 1);
  });
});

// ================================================================ 日志脱敏

test('redact 掩码敏感字段', () => {
  const out = redact({
    appId: '2026000000000001',
    appPrivateKey: 'SECRET',
    alipayPublicKey: 'PUBCERT',
    payment_proof: 'PF',
    client_session: 'CS',
    nested: { seller_signature: 'SIG', amount: '0.01' },
  });

  assert.equal(out.appId, '2026000000000001', '非敏感字段应保留');
  assert.equal(out.nested.amount, '0.01');
  assert.equal(out.appPrivateKey, '[REDACTED]');
  assert.equal(out.alipayPublicKey, '[REDACTED]');
  assert.equal(out.payment_proof, '[REDACTED]');
  assert.equal(out.client_session, '[REDACTED]');
  assert.equal(out.nested.seller_signature, '[REDACTED]');
});

test('createLogger 输出不含敏感值', () => {
  const lines = [];
  const sink = {
    log: (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push(a.join(' ')),
    error: (...a) => lines.push(a.join(' ')),
  };
  const logger = createLogger(sink);
  logger.info('订单 %s', 'ORDER_1');
  logger.error('配置 %j', redact({ appPrivateKey: 'TOPSECRET' }));

  const text = lines.join('\n');
  assert.ok(text.includes('ORDER_1'));
  assert.ok(!text.includes('TOPSECRET'));
});
