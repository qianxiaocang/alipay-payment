'use strict';

/**
 * JsonFileOrderRepository 契约测试
 *
 * 这里验证的是 contract.js 定义的语义，而不是实现细节 ——
 * SQL 实现（sql.js）应满足同一组语义。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { JsonFileOrderRepository, STATUS } = require('../src/repository');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipay-repo-'));
  return path.join(dir, 'orders.json');
}

async function newRepo(filePath = ':memory:') {
  const repo = new JsonFileOrderRepository({ filePath });
  await repo.init();
  return repo;
}

const base = { resourceId: '/r', amount: '0.01', payBefore: '2026-04-15T12:00:00+08:00', goodsName: 'g' };

// ================================================================ 基本读写

test('create / get 往返，初始状态为 PENDING', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'A', ...base });

  const order = await repo.get('A');
  assert.equal(order.status, STATUS.PENDING);
  assert.equal(order.resource_id, '/r');
  assert.equal(order.amount, '0.01');
  assert.equal(order.currency, 'CNY');
  assert.equal(order.service_result, null);
  assert.ok(order.created_at);

  assert.equal(await repo.get('NOPE'), null);
});

test('重复订单号必须失败（唯一性约束）', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'D', ...base });
  await assert.rejects(() => repo.create({ outTradeNo: 'D', ...base }), /订单号重复/);
});

test('size 反映订单数', async () => {
  const repo = await newRepo();
  assert.equal(await repo.size(), 0);
  await repo.create({ outTradeNo: 'S1', ...base });
  await repo.create({ outTradeNo: 'S2', ...base });
  assert.equal(await repo.size(), 2);
});

// ================================================================ 两阶段履约

test('prepareFulfillment 首次生成资源并进入 PENDING_CONFIRM', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'P1', ...base });

  let calls = 0;
  const res = await repo.prepareFulfillment({
    outTradeNo: 'P1',
    tradeNo: 'T1',
    createResource: () => { calls += 1; return 'CONTENT'; },
  });

  assert.equal(calls, 1);
  assert.equal(res.state, STATUS.PENDING_CONFIRM);
  assert.equal(res.serviceResult, 'CONTENT');
  assert.equal(res.alreadyFulfilled, false);

  const order = await repo.get('P1');
  assert.equal(order.status, STATUS.PENDING_CONFIRM);
  assert.equal(order.service_result, 'CONTENT');
  assert.equal(order.trade_no, 'T1');
  assert.ok(order.paid_at, '首次履约应记录 paid_at');
});

test('prepareFulfillment 重复调用复用资源，绝不重新生成', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'P2', ...base });

  let calls = 0;
  const createResource = () => { calls += 1; return `C${calls}`; };

  await repo.prepareFulfillment({ outTradeNo: 'P2', tradeNo: 'T', createResource });
  const second = await repo.prepareFulfillment({ outTradeNo: 'P2', tradeNo: 'T', createResource });
  const third = await repo.prepareFulfillment({ outTradeNo: 'P2', tradeNo: 'T', createResource });

  assert.equal(calls, 1, '资源生成函数只能被调用一次');
  assert.equal(second.serviceResult, 'C1');
  assert.equal(third.serviceResult, 'C1');
  assert.equal(third.state, STATUS.PENDING_CONFIRM);
});

test('prepareFulfillment 并发下只生成一次资源', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'P3', ...base });

  let calls = 0;
  const createResource = () => { calls += 1; return `C${calls}`; };

  const results = await Promise.all(
    Array.from({ length: 25 }, () =>
      repo.prepareFulfillment({ outTradeNo: 'P3', tradeNo: 'T', createResource }),
    ),
  );

  assert.equal(calls, 1, '并发下资源生成函数只能被调用一次');
  assert.ok(results.every((r) => r.serviceResult === 'C1'));
});

test('已 FULFILLED 后 prepareFulfillment 返回 alreadyFulfilled 且不再生成', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'P4', ...base });
  await repo.prepareFulfillment({ outTradeNo: 'P4', tradeNo: 'T', createResource: () => 'C' });
  await repo.completeFulfillment({ outTradeNo: 'P4', tradeNo: 'T' });

  let calls = 0;
  const res = await repo.prepareFulfillment({
    outTradeNo: 'P4',
    tradeNo: 'T',
    createResource: () => { calls += 1; return 'NEW'; },
  });

  assert.equal(res.state, STATUS.FULFILLED);
  assert.equal(res.alreadyFulfilled, true);
  assert.equal(res.serviceResult, 'C');
  assert.equal(calls, 0);
});

test('prepareFulfillment 对不存在的订单返回空结果', async () => {
  const repo = await newRepo();
  const res = await repo.prepareFulfillment({
    outTradeNo: 'NOPE',
    tradeNo: 'T',
    createResource: () => 'C',
  });
  assert.equal(res.order, null);
  assert.equal(res.state, null);
});

// ================================================================ 回执认领

test('claimFulfillmentConfirm 同一时刻只有一个执行者能拿到', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'C1', ...base });
  await repo.prepareFulfillment({ outTradeNo: 'C1', tradeNo: 'T', createResource: () => 'R' });

  const results = await Promise.all(
    Array.from({ length: 10 }, () => repo.claimFulfillmentConfirm({ outTradeNo: 'C1' })),
  );
  assert.equal(results.filter(Boolean).length, 1, '只能有一个认领成功');
});

test('未处于 PENDING_CONFIRM 时不可认领', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'C2', ...base });
  assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: 'C2' }), false, 'PENDING 态不可认领');
});

test('租约未过期时不可被抢占', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'C3', ...base });
  await repo.prepareFulfillment({ outTradeNo: 'C3', tradeNo: 'T', createResource: () => 'R' });

  assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: 'C3', leaseMs: 60000 }), true);
  assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: 'C3' }), false, '租约期内不可抢占');
});

test('租约过期后可被抢占（崩溃恢复）', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'C4', ...base });
  await repo.prepareFulfillment({ outTradeNo: 'C4', tradeNo: 'T', createResource: () => 'R' });

  // 用一个极短租约模拟持有者崩溃
  assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: 'C4', leaseMs: 1 }), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: 'C4' }), true, '租约过期后应可抢占');
});

test('completeFulfillment 闭环并记录成功回执', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'C5', ...base });
  await repo.prepareFulfillment({ outTradeNo: 'C5', tradeNo: 'T', createResource: () => 'R' });
  await repo.claimFulfillmentConfirm({ outTradeNo: 'C5' });

  const order = await repo.completeFulfillment({ outTradeNo: 'C5', tradeNo: 'T' });
  assert.equal(order.status, STATUS.FULFILLED);
  assert.ok(order.fulfilled_at);
  assert.equal(order.fulfillment_confirm.ok, true);
  assert.equal(order.fulfillment_confirm.code, '10000');
  assert.equal(order.confirm_lease_until, null, '闭环后应释放租约');
});

test('releaseFulfillmentClaim 释放认领并留在 PENDING_CONFIRM', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'C6', ...base });
  await repo.prepareFulfillment({ outTradeNo: 'C6', tradeNo: 'T', createResource: () => 'R' });
  await repo.claimFulfillmentConfirm({ outTradeNo: 'C6' });
  await repo.releaseFulfillmentClaim({ outTradeNo: 'C6', code: '40004', subCode: 'SYSTEM_ERROR', subMsg: '系统繁忙' });

  const order = await repo.get('C6');
  assert.equal(order.status, STATUS.PENDING_CONFIRM, '失败后必须留在可重试态');
  assert.equal(order.fulfillment_confirm.ok, false);
  assert.equal(order.fulfillment_confirm.sub_code, 'SYSTEM_ERROR');
  assert.equal(order.confirm_lease_until, null, '失败后应释放租约以便重试');

  // 释放后可再次认领
  assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: 'C6' }), true);
});

// ================================================================ 补偿列表

test('listPendingFulfillmentConfirm 捞出停在 PENDING_CONFIRM 的订单', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'L1', ...base });
  await repo.create({ outTradeNo: 'L2', ...base });
  await repo.prepareFulfillment({ outTradeNo: 'L1', tradeNo: 'T', createResource: () => 'R' });

  const pending = await repo.listPendingFulfillmentConfirm();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].out_trade_no, 'L1');

  await repo.completeFulfillment({ outTradeNo: 'L1', tradeNo: 'T' });
  assert.equal((await repo.listPendingFulfillmentConfirm()).length, 0);
});

// ================================================================ 持久化

test('订单跨实例可恢复，且幂等状态保持', async () => {
  const file = tmpFile();

  const r1 = new JsonFileOrderRepository({ filePath: file });
  await r1.init();
  await r1.create({ outTradeNo: 'X1', ...base });
  await r1.prepareFulfillment({ outTradeNo: 'X1', tradeNo: 'T9', createResource: () => 'RES' });
  await r1.completeFulfillment({ outTradeNo: 'X1', tradeNo: 'T9' });

  const r2 = new JsonFileOrderRepository({ filePath: file });
  await r2.init();

  const order = await r2.get('X1');
  assert.equal(order.status, STATUS.FULFILLED);
  assert.equal(order.service_result, 'RES');
  assert.equal(order.trade_no, 'T9');

  // 恢复后依然不能重复生成资源
  let calls = 0;
  const res = await r2.prepareFulfillment({
    outTradeNo: 'X1',
    tradeNo: 'T9',
    createResource: () => { calls += 1; return 'NEW'; },
  });
  assert.equal(calls, 0);
  assert.equal(res.serviceResult, 'RES');
});

test('落盘为原子替换，不残留临时文件', async () => {
  const file = tmpFile();
  const repo = new JsonFileOrderRepository({ filePath: file });
  await repo.init();
  await repo.create({ outTradeNo: 'A1', ...base });

  const files = fs.readdirSync(path.dirname(file));
  assert.deepEqual(files, ['orders.json'], `目录应只有 orders.json，实际：${files.join(',')}`);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).orders.A1);
});

test('存储文件损坏时给出明确错误', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ this is not json');
  const repo = new JsonFileOrderRepository({ filePath: file });
  await assert.rejects(() => repo.init(), /订单存储文件损坏/);
});

test('supportsMultiInstance 准确反映能力', async () => {
  const repo = await newRepo();
  assert.equal(repo.supportsMultiInstance, false, 'json 文件实现不支持多实例');
});

test('close 可安全调用', async () => {
  const repo = await newRepo();
  await repo.close();
});
