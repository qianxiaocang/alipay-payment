'use strict';

/**
 * JsonFileOrderRepository 契约测试
 *
 * 验证 contract.js 定义的服务端语义，而不是实现细节 ——
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

const base = {
  resourceId: '/r',
  amount: '0.01',
  payBefore: '2026-04-15T12:00:00+08:00',
  goodsName: 'g',
};

/**
 * 走完「认领 → 生成 → 落库」，返回生成结果。
 * 模拟 flow 层与仓储的真实交互顺序（生成发生在锁外）。
 */
async function fulfill(repo, outTradeNo, tradeNo, createResource) {
  const claim = await repo.claimFulfillmentGeneration({ outTradeNo });
  if (claim.state !== 'CLAIMED') {
    return { state: claim.state, serviceResult: claim.serviceResult, generated: false };
  }
  const serviceResult = createResource();
  await repo.storeFulfillmentResult({ outTradeNo, tradeNo, serviceResult });
  return { state: STATUS.PENDING_CONFIRM, serviceResult, generated: true };
}

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
  assert.equal(order.payload_fingerprint, null);
  assert.ok(order.created_at);

  assert.equal(await repo.get('NOPE'), null);
});

test('create 可记录载荷指纹', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'F', ...base, payloadFingerprint: 'abc123' });
  assert.equal((await repo.get('F')).payload_fingerprint, 'abc123');
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

// ================================================================ 资源生成认领

test('首次认领返回 CLAIMED，落库后转为 PENDING_CONFIRM', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'G1', ...base });

  const claim = await repo.claimFulfillmentGeneration({ outTradeNo: 'G1' });
  assert.equal(claim.state, 'CLAIMED');

  await repo.storeFulfillmentResult({ outTradeNo: 'G1', tradeNo: 'T1', serviceResult: 'CONTENT' });

  const order = await repo.get('G1');
  assert.equal(order.status, STATUS.PENDING_CONFIRM);
  assert.equal(order.service_result, 'CONTENT');
  assert.equal(order.trade_no, 'T1');
  assert.equal(order.generate_lease_until, null, '落库后应释放生成租约');
  assert.ok(order.paid_at);
});

test('生成租约未过期时，他人认领得到 IN_PROGRESS', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'G2', ...base });

  assert.equal((await repo.claimFulfillmentGeneration({ outTradeNo: 'G2', leaseMs: 60000 })).state, 'CLAIMED');
  assert.equal((await repo.claimFulfillmentGeneration({ outTradeNo: 'G2' })).state, 'IN_PROGRESS');
});

test('生成租约过期后可被接管（持有者崩溃恢复）', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'G3', ...base });

  assert.equal((await repo.claimFulfillmentGeneration({ outTradeNo: 'G3', leaseMs: 1 })).state, 'CLAIMED');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    (await repo.claimFulfillmentGeneration({ outTradeNo: 'G3' })).state,
    'CLAIMED',
    '租约过期后应可被接管',
  );
});

test('releaseFulfillmentGeneration 释放生成权以便重试', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'G4', ...base });

  await repo.claimFulfillmentGeneration({ outTradeNo: 'G4', leaseMs: 60000 });
  assert.equal((await repo.claimFulfillmentGeneration({ outTradeNo: 'G4' })).state, 'IN_PROGRESS');

  await repo.releaseFulfillmentGeneration({ outTradeNo: 'G4' });
  assert.equal(
    (await repo.claimFulfillmentGeneration({ outTradeNo: 'G4' })).state,
    'CLAIMED',
    '释放后应可立即重新认领',
  );
});

test('并发认领只有一个 CLAIMED', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'G5', ...base });

  const results = await Promise.all(
    Array.from({ length: 25 }, () => repo.claimFulfillmentGeneration({ outTradeNo: 'G5' })),
  );
  assert.equal(results.filter((r) => r.state === 'CLAIMED').length, 1);
  assert.equal(results.filter((r) => r.state === 'IN_PROGRESS').length, 24);
});

test('storeFulfillmentResult 不覆盖已落库资源（幂等）', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'G6', ...base });
  await fulfill(repo, 'G6', 'T', () => 'FIRST');

  await repo.storeFulfillmentResult({ outTradeNo: 'G6', tradeNo: 'T', serviceResult: 'SECOND' });
  assert.equal((await repo.get('G6')).service_result, 'FIRST');
});

test('已生成资源后再次认领直接复用，不再触发生成', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'G7', ...base });

  let calls = 0;
  const createResource = () => { calls += 1; return `C${calls}`; };

  const first = await fulfill(repo, 'G7', 'T', createResource);
  const second = await fulfill(repo, 'G7', 'T', createResource);

  assert.equal(calls, 1, '资源生成只能发生一次');
  assert.equal(first.serviceResult, 'C1');
  assert.equal(second.state, STATUS.PENDING_CONFIRM);
  assert.equal(second.serviceResult, 'C1');
  assert.equal(second.generated, false);
});

test('已 FULFILLED 后认领返回 FULFILLED 且不再生成', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'G8', ...base });
  await fulfill(repo, 'G8', 'T', () => 'RES');
  await repo.claimFulfillmentConfirm({ outTradeNo: 'G8' });
  await repo.completeFulfillment({ outTradeNo: 'G8', tradeNo: 'T' });

  let calls = 0;
  const res = await fulfill(repo, 'G8', 'T', () => { calls += 1; return 'NEW'; });
  assert.equal(res.state, STATUS.FULFILLED);
  assert.equal(res.serviceResult, 'RES');
  assert.equal(calls, 0);
});

test('认领不存在的订单返回 NOT_FOUND', async () => {
  const repo = await newRepo();
  assert.equal((await repo.claimFulfillmentGeneration({ outTradeNo: 'NOPE' })).state, 'NOT_FOUND');
});

// ================================================================ 回执认领

test('claimFulfillmentConfirm 同一时刻只有一个执行者能拿到', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'C1', ...base });
  await fulfill(repo, 'C1', 'T', () => 'R');

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

test('回执租约未过期时不可被抢占', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'C3', ...base });
  await fulfill(repo, 'C3', 'T', () => 'R');

  assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: 'C3', leaseMs: 60000 }), true);
  assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: 'C3' }), false, '租约期内不可抢占');
});

test('回执租约过期后可被抢占（崩溃恢复）', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'C4', ...base });
  await fulfill(repo, 'C4', 'T', () => 'R');

  assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: 'C4', leaseMs: 1 }), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: 'C4' }), true, '租约过期后应可抢占');
});

test('completeFulfillment 闭环并记录成功回执', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'C5', ...base });
  await fulfill(repo, 'C5', 'T', () => 'R');
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
  await fulfill(repo, 'C6', 'T', () => 'R');
  await repo.claimFulfillmentConfirm({ outTradeNo: 'C6' });
  await repo.releaseFulfillmentClaim({
    outTradeNo: 'C6',
    code: '40004',
    subCode: 'SYSTEM_ERROR',
    subMsg: '系统繁忙',
  });

  const order = await repo.get('C6');
  assert.equal(order.status, STATUS.PENDING_CONFIRM, '失败后必须留在可重试态');
  assert.equal(order.fulfillment_confirm.ok, false);
  assert.equal(order.fulfillment_confirm.sub_code, 'SYSTEM_ERROR');
  assert.equal(order.confirm_lease_until, null, '失败后应释放租约以便重试');
  assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: 'C6' }), true);
});

// ================================================================ 补偿列表

test('listPendingFulfillmentConfirm 捞出停在 PENDING_CONFIRM 的订单', async () => {
  const repo = await newRepo();
  await repo.create({ outTradeNo: 'L1', ...base });
  await repo.create({ outTradeNo: 'L2', ...base });
  await fulfill(repo, 'L1', 'T', () => 'R');

  const pending = await repo.listPendingFulfillmentConfirm();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].out_trade_no, 'L1');

  await repo.claimFulfillmentConfirm({ outTradeNo: 'L1' });
  await repo.completeFulfillment({ outTradeNo: 'L1', tradeNo: 'T' });
  assert.equal((await repo.listPendingFulfillmentConfirm()).length, 0);
});

// ================================================================ 持久化

test('订单跨实例可恢复，且幂等状态保持', async () => {
  const file = tmpFile();

  const r1 = new JsonFileOrderRepository({ filePath: file });
  await r1.init();
  await r1.create({ outTradeNo: 'X1', ...base });
  await fulfill(r1, 'X1', 'T9', () => 'RES');
  await r1.claimFulfillmentConfirm({ outTradeNo: 'X1' });
  await r1.completeFulfillment({ outTradeNo: 'X1', tradeNo: 'T9' });

  const r2 = new JsonFileOrderRepository({ filePath: file });
  await r2.init();

  const order = await r2.get('X1');
  assert.equal(order.status, STATUS.FULFILLED);
  assert.equal(order.service_result, 'RES');
  assert.equal(order.trade_no, 'T9');

  // 恢复后依然不能重复生成资源
  let calls = 0;
  const res = await fulfill(r2, 'X1', 'T9', () => { calls += 1; return 'NEW'; });
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
