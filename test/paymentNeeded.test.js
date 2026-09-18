'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { buildPaymentNeeded, build402Body, SIGNED_FIELDS, computeSellerSignature } = require('../src/paymentNeeded');
const { base64UrlDecode, buildSignContent, verifyRsa2 } = require('../src/signing');
const { makeConfig } = require('./helpers');

test('Payment-Needed 分层结构完整（protocol / method）', () => {
  const config = makeConfig();
  const { payload } = buildPaymentNeeded({
    config,
    outTradeNo: 'ORDER_TEST_1',
    resourceId: '/demo/a2m/resource',
  });

  // protocol 层
  for (const f of [
    'out_trade_no',
    'amount',
    'currency',
    'resource_id',
    'pay_before',
    'seller_signature',
    'seller_sign_type',
    'seller_unique_id',
  ]) {
    assert.ok(f in payload.protocol, `protocol 缺少字段 ${f}`);
  }

  // method 层
  for (const f of [
    'seller_name',
    'seller_id',
    'seller_app_id',
    'goods_name',
    'seller_unique_id_key',
    'service_id',
  ]) {
    assert.ok(f in payload.method, `method 缺少字段 ${f}`);
  }

  assert.equal(payload.protocol.seller_sign_type, 'RSA2');
  assert.equal(payload.method.seller_unique_id_key, 'seller_id');
  assert.equal(payload.protocol.currency, 'CNY');
  assert.equal(payload.method.seller_app_id, config.appId);
  assert.equal(payload.method.seller_id, config.sellerId);
  assert.equal(payload.method.service_id, config.serviceId);
  assert.equal(payload.method.seller_name, config.sellerName);
});

test('Payment-Needed 无多余字段（严格对齐文档字段表）', () => {
  const config = makeConfig();
  const { payload } = buildPaymentNeeded({
    config,
    outTradeNo: 'ORDER_TEST_2',
    resourceId: '/demo/a2m/resource',
  });

  assert.deepEqual(Object.keys(payload).sort(), ['method', 'protocol']);

  const expectProtocol = [
    'amount',
    'currency',
    'out_trade_no',
    'pay_before',
    'resource_id',
    'seller_sign_type',
    'seller_signature',
    'seller_unique_id',
  ].sort();
  assert.deepEqual(Object.keys(payload.protocol).sort(), expectProtocol);

  const expectMethod = [
    'goods_name',
    'seller_app_id',
    'seller_id',
    'seller_name',
    'seller_unique_id_key',
    'service_id',
  ].sort();
  assert.deepEqual(Object.keys(payload.method).sort(), expectMethod);
});

test('pay_before 为 ISO 8601 带时区格式，且约等于配置的分钟数', () => {
  const config = makeConfig({ payBeforeMinutes: 45 });
  const now = new Date('2026-04-15T04:00:00Z');
  const { payload } = buildPaymentNeeded({
    config,
    outTradeNo: 'ORDER_TEST_3',
    resourceId: '/demo/a2m/resource',
    now,
  });

  assert.match(payload.protocol.pay_before, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

  // 解析回时间戳，允许时区表示差异
  const parsed = new Date(payload.protocol.pay_before);
  const diffMinutes = (parsed.getTime() - now.getTime()) / 60000;
  assert.ok(Math.abs(diffMinutes - 45) < 1, `截止时间应约为 45 分钟后，实际 ${diffMinutes}`);
});

test('商家签名可被应用公钥验签通过，且覆盖约定的 8 个字段', () => {
  const config = makeConfig();
  const { payload } = buildPaymentNeeded({
    config,
    outTradeNo: 'ORDER_TEST_4',
    resourceId: '/demo/a2m/resource',
  });

  // 从应用私钥导出对应公钥
  const appPublicKey = crypto.createPublicKey(config.appPrivateKey).export({
    type: 'spki',
    format: 'pem',
  });

  const signedParams = {
    amount: payload.protocol.amount,
    currency: payload.protocol.currency,
    goods_name: payload.method.goods_name,
    out_trade_no: payload.protocol.out_trade_no,
    pay_before: payload.protocol.pay_before,
    resource_id: payload.protocol.resource_id,
    seller_id: payload.method.seller_id,
    service_id: payload.method.service_id,
  };

  const content = buildSignContent(signedParams);
  assert.ok(
    verifyRsa2(content, payload.protocol.seller_signature, appPublicKey),
    '商家签名应能通过应用公钥验签',
  );

  // 篡改任一参与签名的字段都应验签失败
  const tampered = buildSignContent({ ...signedParams, amount: '9.99' });
  assert.ok(!verifyRsa2(tampered, payload.protocol.seller_signature, appPublicKey));
});

test('SIGNED_FIELDS 与文档一致', () => {
  assert.deepEqual(
    [...SIGNED_FIELDS].sort(),
    [
      'amount',
      'currency',
      'goods_name',
      'out_trade_no',
      'pay_before',
      'resource_id',
      'seller_id',
      'service_id',
    ].sort(),
  );
});

test('Header 为 Base64URL，解码后等于 payload', () => {
  const config = makeConfig();
  const { payload, header } = buildPaymentNeeded({
    config,
    outTradeNo: 'ORDER_TEST_5',
    resourceId: '/demo/a2m/resource',
  });

  assert.ok(!/[+/=]/.test(header), 'Header 不应含 + / =');
  const decoded = JSON.parse(base64UrlDecode(header));
  assert.deepEqual(decoded, JSON.parse(JSON.stringify(payload)));
});

test('订单要素随配置变化（金额/商品名可覆盖）', () => {
  const config = makeConfig({ amount: '0.01' });
  const { order, payload } = buildPaymentNeeded({
    config,
    outTradeNo: 'ORDER_TEST_6',
    resourceId: '/demo/a2m/resource',
    amount: '12.34',
    goodsName: '定制商品',
  });

  assert.equal(order.amount, '12.34');
  assert.equal(order.goods_name, '定制商品');
  assert.equal(payload.protocol.amount, '12.34');
  assert.equal(payload.method.goods_name, '定制商品');
});

test('computeSellerSignature 对相同输入稳定可复现', () => {
  const config = makeConfig();
  const order = {
    amount: '0.01',
    currency: 'CNY',
    goods_name: 'g',
    out_trade_no: 'ORDER_S',
    pay_before: '2026-04-15T12:00:00+08:00',
    resource_id: '/r',
    seller_id: config.sellerId,
    service_id: config.serviceId,
  };
  const a = computeSellerSignature(order, config.appPrivateKey);
  const b = computeSellerSignature(order, config.appPrivateKey);
  assert.equal(a, b, 'RSA2 PKCS#1 v1.5 签名应确定性可复现');
});

test('build402Body 字段与文档响应体示例一致', () => {
  const body = build402Body({
    outTradeNo: 'ORDER_X',
    amount: '0.01',
    currency: 'CNY',
    goodsName: 'AI 生成内容服务',
  });
  assert.deepEqual(Object.keys(body).sort(), [
    'amount',
    'code',
    'currency',
    'goods_name',
    'message',
    'out_trade_no',
  ]);
  assert.equal(body.code, 'Payment-Needed');
});
