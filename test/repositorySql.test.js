'use strict';

/**
 * SQL 仓储测试
 *
 * 分两部分：
 *   A. 无需数据库的单元测试（方言适配、建表语句、工厂选择）
 *   B. 可选的真库契约测试 —— 只有提供 TEST_DB_DIALECT 时才运行
 *
 * 跑真库契约测试的方式（例）：
 *   TEST_DB_DIALECT=postgres TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=5432 \
 *   TEST_DB_USER=aipay TEST_DB_PASSWORD=secret TEST_DB_NAME=aipay_test \
 *   node --test test/repositorySql.test.js
 *
 * 之所以必须提供这条路径：JSON 文件实现与 SQL 实现的语义必须一致，
 * 而 SQL 的原子性（行锁、唯一约束、租约）只有真库才能验证。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { SqlOrderRepository, SCHEMA } = require('../src/repository/sql');
const { createOrderRepository, JsonFileOrderRepository } = require('../src/repository');
const { STATUS } = require('../src/repository/contract');

// ================================================================ A. 无需数据库

test('PG 方言：? 占位符按顺序转成 $1,$2...', () => {
  const repo = new SqlOrderRepository({ dialect: 'postgres', connection: {} });
  assert.equal(
    repo._adapt('SELECT * FROM t WHERE a = ? AND b = ? AND c = ?'),
    'SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3',
  );
});

test('MySQL 方言：占位符保持 ?', () => {
  const repo = new SqlOrderRepository({ dialect: 'mysql', connection: {} });
  assert.equal(
    repo._adapt('SELECT * FROM t WHERE a = ? AND b = ?'),
    'SELECT * FROM t WHERE a = ? AND b = ?',
  );
});

test('不支持的方言必须拒绝', () => {
  assert.throws(
    () => new SqlOrderRepository({ dialect: 'oracle', connection: {} }),
    /不支持的数据库方言/,
  );
});

test('MySQL 连接强制 UTC，避免时间随时区漂移', () => {
  const repo = new SqlOrderRepository({ dialect: 'mysql', connection: { host: 'h' } });
  const cfg = repo._poolConfig();
  assert.equal(cfg.timezone, 'Z');
  assert.equal(cfg.host, 'h');
});

test('supportsMultiInstance 为 true', () => {
  const repo = new SqlOrderRepository({ dialect: 'postgres', connection: {} });
  assert.equal(repo.supportsMultiInstance, true);
});

test('迁移文件与代码内建表语句保持一致（防止漂移）', () => {
  const dir = path.join(__dirname, '..', 'src', 'repository', 'migrations');
  for (const dialect of ['mysql', 'postgres']) {
    const file = fs.readFileSync(path.join(dir, `${dialect}.sql`), 'utf8');
    for (const stmt of SCHEMA[dialect]) {
      const normalized = stmt.trim().replace(/\s+/g, ' ');
      assert.ok(
        file.replace(/\s+/g, ' ').includes(normalized),
        `${dialect}.sql 缺少代码中的建表语句：${normalized.slice(0, 60)}...`,
      );
    }
  }
});

test('表 DDL 含唯一主键与状态索引（幂等与补偿查询依赖）', () => {
  for (const dialect of ['mysql', 'postgres']) {
    const ddl = SCHEMA[dialect].join('\n');
    assert.match(ddl, /out_trade_no[^\n]*PRIMARY KEY|PRIMARY KEY \(out_trade_no\)/, `${dialect} 缺少主键`);
    assert.match(ddl, /status/, `${dialect} 缺少 status 索引`);
    assert.match(ddl, /confirm_lease_until/, `${dialect} 缺少租约列`);
  }
});

test('工厂：默认返回 JSON 文件实现', () => {
  const repo = createOrderRepository({ storeDriver: 'json', storePath: ':memory:' });
  assert.ok(repo instanceof JsonFileOrderRepository);
  assert.equal(repo.supportsMultiInstance, false);
});

for (const driver of ['mysql', 'postgres']) {
  test(`工厂：${driver} 返回 SQL 实现且方言正确`, () => {
    const repo = createOrderRepository({
      storeDriver: driver,
      db: { host: 'h', port: 1, user: 'u', password: 'p', database: 'd' },
      dbTable: 'aipay_orders',
      confirmLeaseMs: 1000,
    });
    assert.ok(repo instanceof SqlOrderRepository);
    assert.equal(repo.dialect, driver);
    assert.equal(repo.supportsMultiInstance, true);
  });
}

// ================================================================ B. 真库契约测试

const DIALECT = (process.env.TEST_DB_DIALECT || '').trim();
const liveEnabled = DIALECT === 'mysql' || DIALECT === 'postgres';

test('真库契约测试（需 TEST_DB_DIALECT，未设置则跳过）', { skip: !liveEnabled && '未设置 TEST_DB_DIALECT' }, async () => {
  const connection = {
    host: process.env.TEST_DB_HOST || '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT || (DIALECT === 'mysql' ? 3306 : 5432)),
    user: process.env.TEST_DB_USER,
    password: process.env.TEST_DB_PASSWORD,
    database: process.env.TEST_DB_NAME,
  };

  const repo = new SqlOrderRepository({ dialect: DIALECT, connection, autoMigrate: true });
  await repo.init();

  const uniq = `TEST_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const base = {
    resourceId: '/demo/a2m/resource',
    amount: '0.01',
    payBefore: '2026-04-15T12:00:00+08:00',
    goodsName: 'g',
  };
  const created = [];

  const mk = () => {
    const id = `${uniq}_${created.length}`;
    created.push(id);
    return id;
  };

  try {
    // ---- create / get
    const id1 = mk();
    await repo.create({ outTradeNo: id1, ...base });
    const got = await repo.get(id1);
    assert.equal(got.status, STATUS.PENDING);
    assert.equal(got.amount, '0.01');
    assert.equal(got.currency, 'CNY');

    // ---- 唯一约束
    await assert.rejects(() => repo.create({ outTradeNo: id1, ...base }), /订单号重复/);

    // ---- prepareFulfillment 只生成一次（并发）
    let calls = 0;
    const createResource = () => { calls += 1; return `RES_${calls}`; };
    const prepared = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.prepareFulfillment({ outTradeNo: id1, tradeNo: 'T1', createResource }),
      ),
    );
    assert.equal(calls, 1, '并发下资源只能生成一次');
    assert.ok(prepared.every((p) => p.serviceResult === 'RES_1'));
    assert.equal((await repo.get(id1)).status, STATUS.PENDING_CONFIRM);

    // ---- 回执认领：只有一个成功
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => repo.claimFulfillmentConfirm({ outTradeNo: id1 })),
    );
    assert.equal(claims.filter(Boolean).length, 1, '同一时刻只能有一个执行者认领');

    // ---- 失败释放后留在 PENDING_CONFIRM 且可再认领
    await repo.releaseFulfillmentClaim({ outTradeNo: id1, code: '40004', subCode: 'SYSTEM_ERROR' });
    const afterRelease = await repo.get(id1);
    assert.equal(afterRelease.status, STATUS.PENDING_CONFIRM, '失败后必须留在可重试态');
    assert.equal(afterRelease.fulfillment_confirm.ok, false);
    assert.equal(await repo.claimFulfillmentConfirm({ outTradeNo: id1 }), true);

    // ---- 重试不得重新生成资源
    const retried = await repo.prepareFulfillment({ outTradeNo: id1, tradeNo: 'T1', createResource });
    assert.equal(calls, 1, '重试不得重新生成资源');
    assert.equal(retried.serviceResult, 'RES_1');

    // ---- 闭环
    await repo.completeFulfillment({ outTradeNo: id1, tradeNo: 'T1' });
    const closed = await repo.get(id1);
    assert.equal(closed.status, STATUS.FULFILLED);
    assert.equal(closed.fulfillment_confirm.ok, true);
    assert.ok(closed.fulfilled_at);

    // ---- 已闭环后不再生成
    const afterClosed = await repo.prepareFulfillment({ outTradeNo: id1, tradeNo: 'T1', createResource });
    assert.equal(afterClosed.alreadyFulfilled, true);
    assert.equal(calls, 1);

    // ---- 补偿列表能捞出停在 PENDING_CONFIRM 的订单
    const id2 = mk();
    await repo.create({ outTradeNo: id2, ...base });
    await repo.prepareFulfillment({ outTradeNo: id2, tradeNo: 'T2', createResource: () => 'R2' });
    const pending = await repo.listPendingFulfillmentConfirm(500);
    assert.ok(
      pending.some((o) => o.out_trade_no === id2),
      '停在 PENDING_CONFIRM 的订单应出现在补偿列表中',
    );
  } finally {
    // 清理测试数据
    for (const id of created) {
      try {
        await repo._raw(`DELETE FROM ${repo.table} WHERE out_trade_no = ?`, [id]);
      } catch { /* 清理失败不影响断言结果 */ }
    }
    await repo.close();
  }
});
