'use strict';

/**
 * 测试辅助
 *
 * ⚠️ 重要区分：
 *   这里生成的是【一次性测试密钥】，仅用于验证本仓库自身的逻辑
 *   （签名/编码/编排/幂等）。它不是、也绝不能被当作你的真实支付宝配置。
 *   AI 收无沙箱，真实交易必须使用开放平台的正式配置。
 */

const crypto = require('crypto');
const { base64UrlEncode } = require('../src/signing');

/** 生成一次性 RSA 密钥对（应用私钥为 PKCS#1，符合非 JAVA 语言要求） */
function makeTestKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return { privateKey, publicKey };
}

/** 构造与 loadConfig() 同形状的测试配置 */
function makeConfig(overrides = {}) {
  const { privateKey, publicKey } = makeTestKeys();
  return {
    appId: '2026000000000001',
    sellerId: '2088123456789012',
    serviceId: 'service_ai_content_001',
    sellerName: '测试商户',

    amount: '0.01',
    payBeforeMinutes: 30,

    appPrivateKey: privateKey,
    alipayPublicKey: publicKey,

    gateway: 'https://openapi.alipay.com/gateway.do',
    signType: 'RSA2',
    charset: 'UTF-8',
    format: 'json',
    currency: 'CNY',

    resourcePath: '/demo/a2m/resource',
    goodsName: 'AI 生成内容服务',
    port: 3000,
    validateResponseSign: false, // 测试替身不产生真实响应签名
    storePath: ':memory:',

    privateKeySource: 'TEST_KEY',
    publicKeySource: 'TEST_KEY',
    ...overrides,
  };
}

/** 构造 Payment-Proof Header（Base64URL(JSON)） */
function makeProofHeader({
  paymentProof = 'TEST_PAYMENT_PROOF',
  tradeNo = '2026041522001401234567890',
  clientSession = 'TEST_CLIENT_SESSION',
  omit,
} = {}) {
  const protocol = {};
  if (omit !== 'payment_proof') protocol.payment_proof = paymentProof;
  if (omit !== 'trade_no') protocol.trade_no = tradeNo;

  const method = {};
  if (omit !== 'client_session') method.client_session = clientSession;

  return base64UrlEncode(JSON.stringify({ protocol, method }));
}

/**
 * 支付宝 SDK 测试替身
 *
 * 只实现本服务用到的两个接口，用于在不联网、不产生真实交易的前提下
 * 验证编排逻辑。生产环境请使用真实 AlipaySdk（src/alipayClient.js）。
 */
class FakeSdk {
  constructor({ verifyResponse, confirmResponse } = {}) {
    this.calls = [];
    this.verifyResponse = verifyResponse || {
      code: '10000',
      msg: 'Success',
      active: true,
    };
    this.confirmResponse = confirmResponse || { code: '10000', msg: 'Success' };
  }

  async exec(method, params, options) {
    this.calls.push({ method, params, options });

    if (method === 'alipay.aipay.agent.payment.verify') {
      const r = this.verifyResponse;
      if (r instanceof Error) throw r;
      // 支持 (params, options) 形式的函数，便于模拟 validateSign 相关行为
      return typeof r === 'function' ? r(params, options) : r;
    }
    if (method === 'alipay.aipay.agent.fulfillment.confirm') {
      const r = this.confirmResponse;
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(params, options) : r;
    }
    throw new Error(`FakeSdk 未实现的方法: ${method}`);
  }

  countCalls(method) {
    return this.calls.filter((c) => c.method === method).length;
  }
}

module.exports = { makeTestKeys, makeConfig, makeProofHeader, FakeSdk };
