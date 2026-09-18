'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrderStore, STATUS } = require('../src/store');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipay-store-'));
  return path.join(dir, 'orders.json');
}

test('内存模式：创建 / 查询 / 标记履约', async () => {
  const store = new OrderStore({ filePath: ':memory:' });
  await store.init();

  await store.create({
    outTradeNo: 'ORDER_A',
    resourceId: '/r',
    amount: '0.01',
    payBefore: '2026-04-15T12:00:00+08:00',
    goodsName: 'g',
  });

  assert.equal(store.get('ORDER_A').status, STATUS.PENDING);
  assert.equal(store.get('NOPE'), null);

  const claim = await store.markFulfilled('ORDER_A', 'T1');
  assert.equal(claim.alreadyFulfilled, false);
  assert.equal(claim.order.status, STATUS.FULFILLED);
  assert.equal(claim.order.trade_no, 'T1');
});

test('幂等：重复标记履约返回 alreadyFulfilled=true', async () => {
  const store = new OrderStore({ filePath: ':memory:' });
  await store.init();
  await store.create({ outTradeNo: 'O', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' });

  const a = await store.markFulfilled('O', 'T1');
  const b = await store.markFulfilled('O', 'T1');
  assert.equal(a.alreadyFulfilled, false);
  assert.equal(b.alreadyFulfilled, true, '第二次必须是已履约');
});

test('并发标记履约：只有一个返回 alreadyFulfilled=false', async () => {
  const store = new OrderStore({ filePath: ':memory:' });
  await store.init();
  await store.create({ outTradeNo: 'C', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' });

  const results = await Promise.all(
    Array.from({ length: 20 }, () => store.markFulfilled('C', 'T1')),
  );
  assert.equal(results.filter((r) => r.alreadyFulfilled === false).length, 1);
  assert.equal(results.filter((r) => r.alreadyFulfilled === true).length, 19);
});

test('重复订单号应被拒绝', async () => {
  const store = new OrderStore({ filePath: ':memory:' });
  await store.init();
  await store.create({ outTradeNo: 'D', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' });
  await assert.rejects(
    () => store.create({ outTradeNo: 'D', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' }),
    /订单号重复/,
  );
});

test('文件模式：订单可持久化并跨实例恢复', async () => {
  const file = tmpFile();

  const s1 = new OrderStore({ filePath: file });
  await s1.init();
  await s1.create({ outTradeNo: 'P1', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' });
  await s1.markFulfilled('P1', 'T9');

  // 新实例读取同一文件
  const s2 = new OrderStore({ filePath: file });
  await s2.init();

  const order = s2.get('P1');
  assert.ok(order, '订单应能从磁盘恢复');
  assert.equal(order.status, STATUS.FULFILLED);
  assert.equal(order.trade_no, 'T9');

  // 持久化后幂等性依然生效
  const again = await s2.markFulfilled('P1', 'T9');
  assert.equal(again.alreadyFulfilled, true);
});

test('文件写入为原子替换，不残留临时文件', async () => {
  const file = tmpFile();
  const store = new OrderStore({ filePath: file });
  await store.init();
  await store.create({ outTradeNo: 'A1', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' });

  const files = fs.readdirSync(path.dirname(file));
  assert.deepEqual(files, ['orders.json'], `目录应只有 orders.json，实际：${files.join(',')}`);

  // 内容必须是完整合法 JSON
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(parsed.orders.A1);
});

test('存储文件损坏时给出明确错误', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ this is not json');
  const store = new OrderStore({ filePath: file });
  await assert.rejects(() => store.init(), /订单存储文件损坏/);
});

test('回执状态记录与待补偿列表', async () => {
  const store = new OrderStore({ filePath: ':memory:' });
  await store.init();
  await store.create({ outTradeNo: 'F1', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' });
  await store.markFulfilled('F1', 'T1');

  await store.noteFulfillmentConfirm('F1', { ok: false, code: '40004', subCode: 'SYSTEM_ERROR' });
  assert.equal(store.listPendingFulfillmentConfirm().length, 1);

  await store.noteFulfillmentConfirm('F1', { ok: true, code: '10000' });
  assert.equal(store.listPendingFulfillmentConfirm().length, 0);
  assert.equal(store.get('F1').fulfillment_confirm.attempts, 2);
});

test('markPaid 记录支付信息', async () => {
  const store = new OrderStore({ filePath: ':memory:' });
  await store.init();
  await store.create({ outTradeNo: 'M1', resourceId: '/r', amount: '0.01', payBefore: 'x', goodsName: 'g' });

  const order = await store.markPaid('M1', 'T5');
  assert.equal(order.status, STATUS.PAID);
  assert.equal(order.trade_no, 'T5');
  assert.ok(order.paid_at);
});
