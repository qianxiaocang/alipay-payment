'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleResourceRequest } = require('../src/paymentFlow');
const { OrderStore } = require('../src/store');
const { base64UrlDecode, base64UrlEncode } = require('../src/signing');
const { makeConfig, makeProofHeader, FakeSdk } = require('./helpers');

const silentLogger = { info() {}, warn() {}, error() {} };

/** 建一个干净的 store + config */
async function setup(configOverrides) {
  const config = makeConfig(configOverrides);
  const store = new OrderStore({ filePath: ':memory:' });
  await store.init();
  return { config, store };
}

/** 走首次请求，返回 402 结果 */
function initiate(config, store, sdk = new FakeSdk()) {
  return handleResourceRequest({
    paymentProofHeader: undefined,
    config,
    sdk,
    store,
    resourceId: config.resourcePath,
    logger: silentLogger,
  });
}

/** 带上支付凭证走二次请求 */
function pay(config, store, sdk, header, resourceId) {
  return handleResourceRequest({
    paymentProofHeader: header,
    config,
    sdk,
    store,
    resourceId: resourceId ?? config.resourcePath,
    logger: silentLogger,
  });
}

/** 构造一个"支付宝说这个订单已支付"的响应 */
function paidResponse(outTradeNo, overrides = {}) {
  return {
    code: '10000',
    msg: 'Success',
    active: true,
    trade_no: '2026041522001401234567890',
    out_trade_no: outTradeNo,
    resource_id: '/demo/a2m/resource',
    amount: '0.01',
    ...overrides,
  };
}

// ================================================================ 场景一

test('场景一：无凭证 → 402 且返回合法 Payment-Needed，订单落库', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const res = await initiate(config, store, sdk);

  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'Payment-Needed');
  assert.ok(res.headers['Payment-Needed'], '应返回 Payment-Needed 头');

  const decoded = JSON.parse(base64UrlDecode(res.headers['Payment-Needed']));
  assert.equal(decoded.protocol.out_trade_no, res.body.out_trade_no);
  assert.equal(decoded.protocol.seller_sign_type, 'RSA2');

  // 订单必须落库，否则后续无法做资源校验与幂等
  const order = store.get(res.body.out_trade_no);
  assert.ok(order, '订单应已创建');
  assert.equal(order.status, 'PENDING');
  assert.equal(order.resource_id, config.resourcePath);

  // 场景一不应调用任何支付宝接口
  assert.equal(sdk.calls.length, 0);
});

test('场景一：连续两次请求生成不同的订单号', async () => {
  const { config, store } = await setup();
  const a = await initiate(config, store);
  const b = await initiate(config, store);
  assert.notEqual(a.body.out_trade_no, b.body.out_trade_no);
  assert.equal(store.size(), 2);
});

// ================================================================ 场景二 · 成功

test('场景二：校验通过 → 200 + Payment-Validation + 履约回执上报', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  const outTradeNo = first.body.out_trade_no;
  sdk.verifyResponse = paidResponse(outTradeNo);

  const res = await pay(config, store, sdk, makeProofHeader());

  assert.equal(res.status, 200);
  assert.equal(res.body.already_fulfilled, false);
  assert.equal(res.body.out_trade_no, outTradeNo);
  assert.ok(res.headers['Payment-Validation'], '应返回 Payment-Validation 头');

  const pv = JSON.parse(base64UrlDecode(res.headers['Payment-Validation']));
  assert.deepEqual(pv, {
    trade_no: '2026041522001401234567890',
    out_trade_no: outTradeNo,
    validated: true,
    resource_id: config.resourcePath,
  });

  // 履约回执必须上报
  assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 1);

  const order = store.get(outTradeNo);
  assert.equal(order.status, 'FULFILLED');
  assert.equal(order.fulfillment_confirm.ok, true);
});

test('场景二：verify 请求体为 snake_case 且 client_session 原样透传', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no);

  const header = makeProofHeader({
    paymentProof: 'PROOF_ABC',
    tradeNo: '2026041522001401234567890',
    clientSession: 'SESSION_XYZ',
  });
  await pay(config, store, sdk, header);

  const call = sdk.calls.find((c) => c.method === 'alipay.aipay.agent.payment.verify');
  assert.ok(call, '应调用 verify 接口');
  assert.deepEqual(call.params.bizContent, {
    payment_proof: 'PROOF_ABC',
    trade_no: '2026041522001401234567890',
    client_session: 'SESSION_XYZ',
  });
  // 文档强调：client_session 不得被修改、缓存或自行构造
  assert.equal(call.params.bizContent.client_session, 'SESSION_XYZ');
});

// ================================================================ 场景二 · 幂等

test('场景二：重复携带同一凭证 → already_fulfilled，且不重复上报', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no);
  const header = makeProofHeader();

  const r1 = await pay(config, store, sdk, header);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.already_fulfilled, false);

  const r2 = await pay(config, store, sdk, header);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.already_fulfilled, true, '第二次应标记为已履约');
  assert.equal(r2.body.code, 'ALREADY_FULFILLED');

  // 关键资金安全断言：回执只上报一次
  assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 1);
});

test('场景二：并发重复请求 → 只有一个真正履约', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no);
  const header = makeProofHeader();

  const results = await Promise.all([
    pay(config, store, sdk, header),
    pay(config, store, sdk, header),
    pay(config, store, sdk, header),
  ]);

  const delivered = results.filter((r) => r.status === 200 && r.body.already_fulfilled === false);
  const replay = results.filter((r) => r.status === 200 && r.body.already_fulfilled === true);

  assert.equal(delivered.length, 1, '并发下应只有一个请求真正交付资源');
  assert.equal(replay.length, 2, '其余请求应被识别为重复履约');
  assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 1);
});

// ================================================================ 场景二 · 各类拒绝

test('场景二：凭证校验业务码非 10000 → 400 并透出 sub_code', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = {
    code: '40004',
    msg: 'Business Failed',
    sub_code: 'ACQ.TRADE_NOT_EXIST',
    sub_msg: '交易不存在',
  };

  const res = await pay(config, store, sdk, makeProofHeader({ tradeNo: first.body.out_trade_no }));

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ACQ.TRADE_NOT_EXIST');
  assert.equal(res.body.message, '交易不存在');
  assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 0);
});

test('场景二：active=false（凭证无效/过期）→ 400 且不履约', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { active: false });

  const res = await pay(config, store, sdk, makeProofHeader());

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_PAYMENT_PROOF');
  assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 0);
  assert.equal(store.get(first.body.out_trade_no).status, 'PENDING');
});

test('场景二：资源ID不匹配（资源串改）→ 403 且不履约', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { resource_id: '/other/resource' });

  const res = await pay(config, store, sdk, makeProofHeader());

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'RESOURCE_ID_MISMATCH');
  assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 0);
});

test('场景二：请求资源与订单资源不一致 → 403', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no);

  const res = await pay(config, store, sdk, makeProofHeader(), '/some/other/path');

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'RESOURCE_ID_MISMATCH');
});

test('场景二：金额不一致 → 400 且不履约', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { amount: '9.99' });

  const res = await pay(config, store, sdk, makeProofHeader());

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'AMOUNT_MISMATCH');
  assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 0);
});

test('场景二：金额等值不同表示（0.01 vs 0.010）不应误判', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { amount: '0.010' });

  const res = await pay(config, store, sdk, makeProofHeader());
  assert.equal(res.status, 200);
});

test('场景二：订单不存在 → 404', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();
  sdk.verifyResponse = paidResponse('ORDER_NOT_IN_STORE');

  const res = await pay(config, store, sdk, makeProofHeader());

  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'ORDER_NOT_FOUND');
});

test('场景二：校验接口抛异常 → 500 VERIFY_FAILED', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = new Error('网关超时');

  const res = await pay(config, store, sdk, makeProofHeader());

  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'VERIFY_FAILED');
});

// ================================================================ 凭证解析

test('凭证格式非法 → 400 INVALID_PAYMENT_PROOF_FORMAT', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  for (const bad of ['not-base64url!!!', base64UrlEncode('not json'), base64UrlEncode('{}')]) {
    const res = await pay(config, store, sdk, bad);
    assert.equal(res.status, 400, `输入 ${bad} 应被拒绝`);
    assert.equal(res.body.code, 'INVALID_PAYMENT_PROOF_FORMAT');
  }
  assert.equal(sdk.calls.length, 0, '格式非法时不应调用支付宝接口');
});

test('凭证缺少 client_session → 400（该字段必须透传）', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const header = makeProofHeader({ omit: 'client_session' });
  const res = await pay(config, store, sdk, header);

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_PAYMENT_PROOF_FORMAT');
  assert.match(res.body.message, /client_session/);
});

test('凭证缺少 trade_no → 400', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const res = await pay(config, store, sdk, makeProofHeader({ omit: 'trade_no' }));
  assert.equal(res.status, 400);
  assert.match(res.body.message, /trade_no/);
});

test('凭证字段平铺在顶层时也能解析（容错）', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no);

  const flatHeader = base64UrlEncode(
    JSON.stringify({
      payment_proof: 'PF',
      trade_no: '2026041522001401234567890',
      client_session: 'CS',
    }),
  );

  const res = await pay(config, store, sdk, flatHeader);
  assert.equal(res.status, 200);
});

// ================================================================ 回执失败

test('履约回执上报失败时仍交付资源，并留痕待补偿', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no);
  sdk.confirmResponse = { code: '40004', sub_code: 'SYSTEM_ERROR', sub_msg: '系统繁忙' };

  const res = await pay(config, store, sdk, makeProofHeader());

  // 消费者已付款，应拿到资源
  assert.equal(res.status, 200);
  assert.ok(res.body.content);

  const order = store.get(first.body.out_trade_no);
  assert.equal(order.fulfillment_confirm.ok, false);
  assert.equal(order.fulfillment_confirm.sub_code, 'SYSTEM_ERROR');
  assert.equal(order.fulfillment_confirm.attempts, 1);

  // 应可被补偿任务捞出
  const pending = store.listPendingFulfillmentConfirm();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].out_trade_no, first.body.out_trade_no);
});

test('履约回执抛异常时仍交付资源', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no);
  sdk.confirmResponse = new Error('网络中断');

  const res = await pay(config, store, sdk, makeProofHeader());
  assert.equal(res.status, 200);
  assert.equal(store.get(first.body.out_trade_no).fulfillment_confirm.ok, false);
});

// ================================================================ 业务资源

test('自定义资源生成器被调用，异常时返回 500 FULFILLMENT_ERROR', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no);

  let called = false;
  const res = await handleResourceRequest({
    paymentProofHeader: makeProofHeader(),
    config,
    sdk,
    store,
    resourceId: config.resourcePath,
    generateResource: () => {
      called = true;
      return 'CUSTOM_CONTENT';
    },
    logger: silentLogger,
  });

  assert.ok(called, '自定义生成器应被调用');
  assert.equal(res.status, 200);
  assert.equal(res.body.content, 'CUSTOM_CONTENT');

  // 生成器抛错
  const { config: c2, store: s2 } = await setup();
  const sdk2 = new FakeSdk();
  const f2 = await initiate(c2, s2, sdk2);
  sdk2.verifyResponse = paidResponse(f2.body.out_trade_no);

  const res2 = await handleResourceRequest({
    paymentProofHeader: makeProofHeader(),
    config: c2,
    sdk: sdk2,
    store: s2,
    resourceId: c2.resourcePath,
    generateResource: () => {
      throw new Error('业务失败');
    },
    logger: silentLogger,
  });

  assert.equal(res2.status, 500);
  assert.equal(res2.body.code, 'FULFILLMENT_ERROR');
});

// ================================================================ 金额配置

test('配置金额变化会体现在 402 响应与订单中', async () => {
  const { config, store } = await setup({ amount: '19.90' });
  const res = await initiate(config, store);

  assert.equal(res.body.amount, '19.90');
  assert.equal(store.get(res.body.out_trade_no).amount, '19.90');

  const decoded = JSON.parse(base64UrlDecode(res.headers['Payment-Needed']));
  assert.equal(decoded.protocol.amount, '19.90');
});
