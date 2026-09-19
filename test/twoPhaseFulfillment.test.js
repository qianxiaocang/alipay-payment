'use strict';

/**
 * 流程级专项测试：资源标识强校验 与 两阶段履约（含回执重试）
 *
 * 对应三处生产风险修正：
 *   1. 网关响应缺少 resource_id 时必须按异常处理，不得被当作校验通过
 *      （原实现是「存在才比较」，等于留了一个绕过防串校验的口子）
 *   2. 履约回执失败不得返回成功交付，且允许用同一 Payment-Proof 重试补发
 *      （原实现生成资源即置 FULFILLED，回执失败后永久无法补发）
 *   3. 并发/多实例下资源只生成一次、回执只上报一次
 *
 * 仓储层自身的语义见 repositoryJsonFile.test.js。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { JsonFileOrderRepository, STATUS } = require('../src/repository');
const { handleResourceRequest } = require('../src/paymentFlow');
const { makeConfig, makeProofHeader, FakeSdk } = require('./helpers');

const silentLogger = { info() {}, warn() {}, error() {} };

async function setup(configOverrides) {
  const config = makeConfig(configOverrides);
  const store = new JsonFileOrderRepository({ filePath: ':memory:' });
  await store.init();
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
    repository: store,
    resourceId: config.resourcePath,
    logger: silentLogger,
  });
}

async function pay(config, store, sdk, generateResource) {
  return handleResourceRequest({
    paymentProofHeader: makeProofHeader(),
    config,
    sdk,
    repository: store,
    resourceId: config.resourcePath,
    generateResource,
    logger: silentLogger,
  });
}

// ================================================================ 资源标识强校验

test('网关响应缺少 resource_id → 502 RESOURCE_ID_MISSING，不履约', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { resource_id: undefined });

  const res = await pay(config, store, sdk);

  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'RESOURCE_ID_MISSING');
  assert.equal(sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'), 0, '不得履约');
  assert.equal((await store.get(first.body.out_trade_no)).status, STATUS.PENDING);
});

test('空字符串 resource_id → 502 RESOURCE_ID_MISSING（空串视为缺失）', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { resource_id: '' });

  const res = await pay(config, store, sdk);
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'RESOURCE_ID_MISSING');
});

test('仅空白 resource_id → 502 RESOURCE_ID_MISSING', async () => {
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

// ================================================================ 并发幂等

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
  assert.equal(replayed.length, 4, '其余应复用已履约结果（等待收敛）');

  for (const r of results.filter((x) => x.status === 200)) {
    assert.ok(r.body.content, '成功响应必须带非空 content');
    assert.ok(r.headers['Payment-Validation']);
  }
});

// ================================================================ 回执失败与重试

test('回执失败 → 502，订单停在 PENDING_CONFIRM 且可被补偿任务捞出', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  const outTradeNo = first.body.out_trade_no;
  sdk.verifyResponse = paidResponse(outTradeNo);
  sdk.confirmResponse = { code: '40004', sub_code: 'SYSTEM_ERROR', sub_msg: '系统繁忙' };

  let generateCount = 0;
  const generateResource = () => { generateCount += 1; return `RES_${generateCount}`; };

  const res = await pay(config, store, sdk, generateResource);

  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'FULFILLMENT_CONFIRM_FAILED');

  const order = await store.get(outTradeNo);
  assert.equal(order.status, STATUS.PENDING_CONFIRM);
  assert.equal(order.fulfillment_confirm.ok, false);
  assert.equal(order.fulfillment_confirm.sub_code, 'SYSTEM_ERROR');
  assert.equal(generateCount, 1, '资源只应生成一次');

  assert.equal((await store.listPendingFulfillmentConfirm()).length, 1);
});

test('回执失败后用同一凭证重试 → 补发成功且资源不重新生成', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  const outTradeNo = first.body.out_trade_no;
  sdk.verifyResponse = paidResponse(outTradeNo);
  sdk.confirmResponse = new Error('临时网络故障');

  let generateCount = 0;
  const generateResource = () => { generateCount += 1; return 'RESOURCE_V1'; };

  const failed = await pay(config, store, sdk, generateResource);
  assert.equal(failed.status, 502);

  // 故障恢复，同一凭证重试
  sdk.confirmResponse = { code: '10000', msg: 'Success' };
  const ok = await pay(config, store, sdk, generateResource);

  assert.equal(ok.status, 200);
  assert.equal(ok.body.content, 'RESOURCE_V1', '重试必须复用首次生成的资源');
  assert.equal(ok.body.already_fulfilled, false);
  assert.equal(generateCount, 1, '重试不得重新生成资源');
  assert.equal((await store.get(outTradeNo)).status, STATUS.FULFILLED);
  assert.equal((await store.listPendingFulfillmentConfirm()).length, 0);

  // 第三次：已闭环，复用
  const third = await pay(config, store, sdk, generateResource);
  assert.equal(third.status, 200);
  assert.equal(third.body.already_fulfilled, true);
  assert.equal(third.body.content, 'RESOURCE_V1');
  assert.equal(generateCount, 1);
  assert.equal(
    sdk.countCalls('alipay.aipay.agent.fulfillment.confirm'),
    2,
    '首次失败 + 重试成功 = 2 次',
  );
});

test('回执抛异常 → 502，留存失败信息', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no);
  sdk.confirmResponse = new Error('网络中断');

  const res = await pay(config, store, sdk);

  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'FULFILLMENT_CONFIRM_FAILED');
  const order = await store.get(first.body.out_trade_no);
  assert.equal(order.status, STATUS.PENDING_CONFIRM);
  assert.equal(order.fulfillment_confirm.ok, false);
});

test('金额字段为空时跳过金额比对，但资源校验仍生效', async () => {
  const { config, store } = await setup();
  const sdk = new FakeSdk();

  const first = await initiate(config, store, sdk);
  sdk.verifyResponse = paidResponse(first.body.out_trade_no, { amount: '' });

  const res = await pay(config, store, sdk);
  assert.equal(res.status, 200);
});
