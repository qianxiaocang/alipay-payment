'use strict';

/**
 * 两阶段履约 与 资源标识强校验 的专项测试
 *
 * 对应两处生产环境修正：
 *   1. 网关响应缺少 resource_id 时必须按异常处理，不能被当作校验通过
 *      （原实现是「存在才比较」，等于留了一个绕过防串校验的口子）
 *   2. 履约回执失败不得返回成功交付，且允许用同一 Payment-Proof 重试补发
 *      （原实现生成资源即置 FULFILLED，回执失败后永久无法补发）
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { OrderStore, STATUS } = require('../src/store');
const { handleResourceRequest } = require('../src/paymentFlow');
const { makeConfig, makeProofHeader, FakeSdk } = require('./helpers');

const silentLogger = { info() {}, warn() {}, error() {} };

function newStore() {
  const store = new OrderStore({ filePath: ':memory:' });
  return store.init().then(() => store);
}

async function setup() {
  const config = makeConfig();
  const store = await newStore();
  return { config, store };
}

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

async function initiate(config, store, sdk) {
  return handleResourceRequest({
    paymentProofHeader: undefined,
    config,
    sdk,
    store,
    resourceId: config.resourcePath,
    logger: silentLogger,
  });
}

async function pay(config, store, sdk, generateResource) {
  return handleResourceRequest({
    paymentProofHeader: makeProofHeader(),
    config,
    sdk,
    store,
    resourceId: config.resourcePath,
    generateResource,
    logger: silentLogger,
  });
}

// ================================================================ 存储层

test('prepareFulfillment 首次生成资源并进入 PENDING_CONFIRM', async () => {
  const store = await newStore();
  await store.create({ outTradeNo: 'O1', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' });

  let calls = 0;
  const res = await store.prepareFulfillment({
    outTradeNo: 'O1',
    tradeNo: 'T1',
    createResource: () => {
      calls += 1;
      return 'CONTENT';
    },
  });

  assert.equal(calls, 1);
  assert.equal(res.state, STATUS.PENDING_CONFIRM);
  assert.equal(res.serviceResult, 'CONTENT');
  assert.equal(res.alreadyFulfilled, false);
  assert.equal(store.get('O1').status, STATUS.PENDING_CONFIRM);
  assert.equal(store.get('O1').service_result, 'CONTENT');
});

test('prepareFulfillment 重复调用复用资源，绝不重新生成', async () => {
  const store = await newStore();
  await store.create({ outTradeNo: 'O2', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' });

  let calls = 0;
  const createResource = () => {
    calls += 1;
    return `C${calls}`;
  };

  await store.prepareFulfillment({ outTradeNo: 'O2', tradeNo: 'T', createResource });
  const second = await store.prepareFulfillment({ outTradeNo: 'O2', tradeNo: 'T', createResource });
  const third = await store.prepareFulfillment({ outTradeNo: 'O2', tradeNo: 'T', createResource });

  assert.equal(calls, 1, '资源生成函数只应被调用一次');
  assert.equal(second.serviceResult, 'C1');
  assert.equal(third.serviceResult, 'C1');
  assert.equal(third.state, STATUS.PENDING_CONFIRM);
});

test('prepareFulfillment 在订单已 FULFILLED 时返回 alreadyFulfilled', async () => {
  const store = await newStore();
  await store.create({ outTradeNo: 'O3', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' });
  await store.prepareFulfillment({ outTradeNo: 'O3', tradeNo: 'T', createResource: () => 'C' });
  await store.markFulfilled('O3', 'T');

  let calls = 0;
  const res = await store.prepareFulfillment({
    outTradeNo: 'O3',
    tradeNo: 'T',
    createResource: () => {
      calls += 1;
      return 'NEW';
    },
  });

  assert.equal(res.state, STATUS.FULFILLED);
  assert.equal(res.alreadyFulfilled, true);
  assert.equal(res.serviceResult, 'C');
  assert.equal(calls, 0, '已闭环后不得再生成资源');
});

test('并发 prepareFulfillment 只生成一次资源', async () => {
  const store = await newStore();
  await store.create({ outTradeNo: 'O4', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' });

  let calls = 0;
  const createResource = () => {
    calls += 1;
    return `C${calls}`;
  };

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      store.prepareFulfillment({ outTradeNo: 'O4', tradeNo: 'T', createResource }),
    ),
  );

  assert.equal(calls, 1, '并发下资源生成函数只能被调用一次');
  assert.ok(results.every((r) => r.serviceResult === 'C1'));
});

test('prepareFulfillment 对不存在的订单返回空结果', async () => {
  const store = await newStore();
  const res = await store.prepareFulfillment({
    outTradeNo: 'NOPE',
    tradeNo: 'T',
    createResource: () => 'C',
  });
  assert.equal(res.order, null);
  assert.equal(res.state, null);
});

test('withOrderLock 串行执行同一 key 的任务', async () => {
  const store = await newStore();
  const order = [];
  const task = (id) =>
    store.withOrderLock('K', async () => {
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end-${id}`);
    });

  await Promise.all([task(1), task(2), task(3)]);

  // 必须严格 start/end 成对出现，不能交错
  assert.deepEqual(order, [
    'start-1', 'end-1',
    'start-2', 'end-2',
    'start-3', 'end-3',
  ]);
});

test('withOrderLock 单次失败不阻断后续排队者', async () => {
  const store = await newStore();
  const ran = [];

  const p1 = store.withOrderLock('K2', async () => {
    throw new Error('boom');
  });
  const p2 = store.withOrderLock('K2', async () => {
    ran.push('second');
    return 'ok';
  });

  await assert.rejects(() => p1, /boom/);
  assert.equal(await p2, 'ok');
  assert.deepEqual(ran, ['second']);
});

// ================================================================ 资源标识强校验

test('网关响应缺少 resource_id → 502 RESOURCE_ID_MISSING，不交付', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  // 完全不返回 resource_id
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { resource_id: undefined });

  const res = await pay(config, store, sdk);

  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'RESOURCE_ID_MISSING');
  assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 0, '不得履约');
  assert.equal(store.get(first.body.out_trade_no).status, STATUS.PENDING);
});

test('网关返回空字符串 resource_id → 502 RESOURCE_ID_MISSING（空串视为缺失）', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { resource_id: '' });

  const res = await pay(config, store, sdk);

  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'RESOURCE_ID_MISSING');
  assert.equal(store.get(first.body.out_trade_no).status, STATUS.PENDING);
});

test('网关返回仅空白 resource_id → 502 RESOURCE_ID_MISSING', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { resource_id: '   ' });

  const res = await pay(config, store, sdk);
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'RESOURCE_ID_MISSING');
});

test('resource_id 存在但不匹配 → 403（与缺失区分开）', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { resource_id: '/other' });

  const res = await pay(config, store, sdk);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'RESOURCE_ID_MISMATCH');
});

// ================================================================ 端到端幂等

test('并发同一凭证：资源只生成一次、回执只上报一次、只交付一次', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no);

  let generateCount = 0;
  const generateResource = () => {
    generateCount += 1;
    return `RES_${generateCount}`;
  };

  const results = await Promise.all(
    Array.from({ length: 5 }, () => pay(config, store, sdk, generateResource)),
  );

  assert.equal(generateCount, 1, '资源只能生成一次');
  assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 1, '回执只能上报一次');

  const delivered = results.filter((r) => r.status === 200 && r.body.already_fulfilled === false);
  const replayed = results.filter((r) => r.status === 200 && r.body.already_fulfilled === true);

  assert.equal(delivered.length, 1, '只应有一个请求真正完成交付');
  assert.equal(replayed.length, 4, '其余应识别为已履约');

  // 所有成功响应都必须带非空 content
  for (const r of results.filter((x) => x.status === 200)) {
    assert.ok(r.body.content, '成功响应必须带非空 content');
    assert.ok(r.headers['Payment-Validation']);
  }
});

test('回执失败后重试用同一凭证：补发回执并闭环，资源不重新生成', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  const outTradeNo = first.body.out_trade_no;
  sdk.verifyResponse = paidResponse(outTradeNo);
  sdk.confirmResponse = new Error('临时网络故障');

  let generateCount = 0;
  const generateResource = () => {
    generateCount += 1;
    return 'RESOURCE_V1';
  };

  const failed = await pay(config, store, sdk, generateResource);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, 'FULFILLMENT_CONFIRM_FAILED');
  assert.equal(store.get(outTradeNo).status, STATUS.PENDING_CONFIRM);
  assert.equal(store.listPendingFulfillmentConfirm().length, 1);

  // 故障恢复，用同一凭证重试
  sdk.confirmResponse = { code: '10000', msg: 'Success' };
  const ok = await pay(config, store, sdk, generateResource);

  assert.equal(ok.status, 200);
  assert.equal(ok.body.content, 'RESOURCE_V1');
  assert.equal(ok.body.already_fulfilled, false);
  assert.equal(generateCount, 1, '重试不得重新生成资源');
  assert.equal(store.get(outTradeNo).status, STATUS.FULFILLED);
  assert.equal(store.listPendingFulfillmentConfirm().length, 0);

  // 第三次请求：已闭环，直接复用
  const third = await pay(config, store, sdk, generateResource);
  assert.equal(third.status, 200);
  assert.equal(third.body.already_fulfilled, true);
  assert.equal(third.body.content, 'RESOURCE_V1');
  assert.equal(generateCount, 1);
  assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 2, '首次失败 + 重试成功 = 2 次');
});

test('金额缺失不作为放行理由之外的异常（仍以订单金额为准）', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { amount: '' });

  const res = await pay(config, store, sdk);
  // 金额字段为空时跳过金额比对（resource_id 仍强校验），最终交付成功
  assert.equal(res.status, 200);
});
