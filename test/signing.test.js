'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const {
  buildSignContent,
  signRsa2,
  verifyRsa2,
  base64UrlEncode,
  base64UrlDecode,
  formatIso8601WithTimezone,
  generateOutTradeNo,
} = require('../src/signing');
const { makeTestKeys } = require('./helpers');

test('buildSignContent: 按 key 字典序排序并用 & 连接', () => {
  const content = buildSignContent({
    service_id: 'svc',
    amount: '0.01',
    out_trade_no: 'ORDER_1',
    currency: 'CNY',
  });
  assert.equal(content, 'amount=0.01&currency=CNY&out_trade_no=ORDER_1&service_id=svc');
});

test('buildSignContent: 跳过 null/undefined/空字符串，且不留下多余 &', () => {
  const content = buildSignContent({
    b: '2',
    a: '1',
    empty: '',
    nul: null,
    undef: undefined,
    c: '3',
  });
  assert.equal(content, 'a=1&b=2&c=3');
  assert.ok(!content.includes('&&'));
  assert.ok(!content.endsWith('&'));
});

test('buildSignContent: 空对象返回空串', () => {
  assert.equal(buildSignContent({}), '');
});

test('Base64URL 编解码可逆，且不含 + / =', () => {
  const cases = [
    'hello',
    '中文内容 with spaces',
    JSON.stringify({ a: 1, b: '中文' }),
    'x'.repeat(1000),
    '', // 空串
  ];
  for (const input of cases) {
    const encoded = base64UrlEncode(input);
    assert.ok(!/[+/=]/.test(encoded), `编码结果不应含 + / = : ${encoded}`);
    assert.equal(base64UrlDecode(encoded), input);
  }
});

test('Base64URL 解码兼容标准 Base64 字符', () => {
  const raw = Buffer.from('some payload ??>>', 'utf8').toString('base64');
  assert.equal(base64UrlDecode(raw), 'some payload ??>>');
});

test('formatIso8601WithTimezone 输出带时区偏移的 ISO 8601', () => {
  const s = formatIso8601WithTimezone(new Date('2026-04-15T04:54:37Z'));
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, `实际: ${s}`);
  // 必须是 yyyy-MM-dd HH:mm:ss 之外的格式（AI 收用 ISO 8601）
  assert.ok(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s));
});

/**
 * pay_before 依赖服务器的本地时区。
 * 这里用子进程 + TZ 环境变量验证，避免受运行期 process.env.TZ 修改的影响。
 *
 * 注意：本用例零偏移用 GMT 而非 UTC —— 某些容器镜像的 Etc/UTC 时区数据
 * 被改写过，`TZ=UTC` 会错误地解析成 +08:00；`TZ=GMT` 才是可靠的零偏移基准。
 * 这一点也提示运维：上线前务必核对服务器时区（见 README）。
 */
test('formatIso8601WithTimezone 在指定时区下输出正确偏移', () => {
  const script = `
    const { formatIso8601WithTimezone } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'signing.js'))});
    process.stdout.write(formatIso8601WithTimezone(new Date('2026-04-15T04:54:37Z')));
  `;

  const cases = [
    ['GMT', '2026-04-15T04:54:37+00:00'],
    ['Asia/Shanghai', '2026-04-15T12:54:37+08:00'],
    ['America/New_York', '2026-04-15T00:54:37-04:00'], // 4 月为 EDT（-04:00）
    ['Europe/London', '2026-04-15T05:54:37+01:00'], // 4 月为 BST（+01:00）
  ];

  for (const [tz, expected] of cases) {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    });
    assert.equal(out, expected, `TZ=${tz} 时输出不符`);
  }
});

test('RSA2 签名可被对应公钥验签通过', () => {
  const { privateKey, publicKey } = makeTestKeys();
  const content = 'amount=0.01&currency=CNY&out_trade_no=ORDER_1';
  const sig = signRsa2(content, privateKey);
  assert.equal(typeof sig, 'string');
  assert.ok(verifyRsa2(content, sig, publicKey), '正确内容应验签通过');
  assert.ok(!verifyRsa2(`${content}&x=1`, sig, publicKey), '被篡改的内容应验签失败');
});

test('RSA2 验签对垃圾数据返回 false 而不抛错', () => {
  const { publicKey } = makeTestKeys();
  assert.equal(verifyRsa2('abc', 'not-a-signature', publicKey), false);
});

test('generateOutTradeNo 生成唯一订单号', () => {
  const set = new Set();
  for (let i = 0; i < 500; i++) set.add(generateOutTradeNo());
  assert.equal(set.size, 500, '500 次生成应无重复');
  for (const v of set) assert.match(v, /^ORDER_\d+_[0-9a-f]{8}$/);
});
