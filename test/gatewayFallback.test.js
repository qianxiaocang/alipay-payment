'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { execGateway, isUnsignedResponseError, callPaymentVerify } = require('../src/verify');
const { handleResourceRequest } = require('../src/paymentFlow');
const { OrderStore } = require('../src/store');
const { makeConfig, makeProofHeader, FakeSdk } = require('./helpers');

const silentLogger = { info() {}, warn() {}, error() {} };

/** 复现 alipay-sdk 在「无签名响应」时真实抛出的错误 */
function realUnsignedResponseError() {
  try {
    const v = crypto.createVerify('RSA-SHA256');
    v.update('x', 'utf8');
    v.verify('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', undefined, 'base64');
    throw new Error('预期应当抛错，但未抛错');
  } catch (err) {
    return err;
  }
}

/**
 * 模拟真实 SDK 行为的替身：
 *   validateSign=true 时对无签名响应抛 crypto TypeError（与实测一致）
 *   validateSign=false 时正常返回 error_response
 */
function makingSdk({ errorResponse, successResponseOnUnsigned = false }) {
  const sdk = new FakeSdk();
  sdk.verifyResponse = (params, options) => {
    if (options && options.validateSign) {
      throw realUnsignedResponseError();
    }
    if (successResponseOnUnsigned) {
      return { code: '10000', msg: 'Success', active: true, trade_no: 'T', out_trade_no: 'O' };
    }
    return errorResponse;
  };
  return sdk;
}

// ================================================================ 错误识别

test('isUnsignedResponseError 能识别无签名响应错误', () => {
  const err = realUnsignedResponseError();
  assert.equal(err.name, 'TypeError');
  assert.ok(isUnsignedResponseError(err), '应被识别为无签名响应错误');
});

test('isUnsignedResponseError 不误判真实验签失败（安全信号）', () => {
  const signFail = new Error("验签失败，服务端返回的 sign: 'abc' 无效");
  signFail.name = 'AlipayRequestError';
  assert.equal(isUnsignedResponseError(signFail), false);

  assert.equal(isUnsignedResponseError(new Error('网络超时')), false);
  assert.equal(isUnsignedResponseError(new TypeError('其他类型错误')), false);
});

// ================================================================ execGateway

test('validateSign=true 遇到无签名响应 → 降级重试取回真实错误码', async () => {
  const sdk = makingSdk({
    errorResponse: {
      code: '40002',
      msg: 'Invalid Arguments',
      sub_code: 'isv.invalid-app-id',
      sub_msg: '无效的AppID参数',
    },
  });

  const { response, signatureValidated } = await execGateway({
    sdk,
    method: 'alipay.aipay.agent.payment.verify',
    bizContent: { a: 1 },
    validateSign: true,
  });

  assert.equal(response.sub_code, 'isv.invalid-app-id', '应取回真实错误码');
  assert.equal(signatureValidated, false, '必须标记该响应未经验签');
  assert.equal(sdk.calls.length, 2, '应重试一次');
  assert.equal(sdk.calls[0].options.validateSign, true);
  assert.equal(sdk.calls[1].options.validateSign, false);
});

test('安全：未验签却返回成功 → 拒绝采信', async () => {
  const sdk = makingSdk({ errorResponse: null, successResponseOnUnsigned: true });

  await assert.rejects(
    () =>
      execGateway({
        sdk,
        method: 'alipay.aipay.agent.payment.verify',
        bizContent: {},
        validateSign: true,
      }),
    (err) => {
      assert.equal(err.code, 'UNSIGNED_SUCCESS_REJECTED');
      assert.match(err.message, /拒绝采信/);
      return true;
    },
  );
});

test('安全：真实验签失败必须直接抛出，不得降级重试', async () => {
  const sdk = new FakeSdk();
  const signErr = new Error("验签失败，服务端返回的 sign: 'bad' 无效");
  signErr.name = 'AlipayRequestError';
  sdk.verifyResponse = signErr;

  await assert.rejects(
    () =>
      execGateway({
        sdk,
        method: 'alipay.aipay.agent.payment.verify',
        bizContent: {},
        validateSign: true,
      }),
    /验签失败/,
  );
  assert.equal(sdk.calls.length, 1, '真实验签失败不应重试');
});

test('validateSign=false 时不重试，只调用一次', async () => {
  const sdk = new FakeSdk({ verifyResponse: { code: '40002', sub_code: 'isv.invalid-app-id' } });

  const { response, signatureValidated } = await execGateway({
    sdk,
    method: 'alipay.aipay.agent.payment.verify',
    bizContent: {},
    validateSign: false,
  });

  assert.equal(response.sub_code, 'isv.invalid-app-id');
  assert.equal(signatureValidated, false);
  assert.equal(sdk.calls.length, 1);
});

test('callPaymentVerify 归一化后的字段可读，且标记签名状态', async () => {
  const sdk = makingSdk({ errorResponse: { code: '40002', sub_code: 'isv.invalid-app-id', sub_msg: '无效的AppID参数' } });

  const result = await callPaymentVerify({
    sdk,
    paymentProof: 'p',
    tradeNo: 't',
    clientSession: 'c',
    validateSign: true,
  });

  assert.equal(result.code, '40002');
  assert.equal(result.subCode, 'isv.invalid-app-id');
  assert.equal(result.subMsg, '无效的AppID参数');
  assert.equal(result.signatureValidated, false);
});

// ================================================================ 端到端

test('端到端：开启响应验签时，配置类错误仍能看到真实错误码（而非 crypto 报错）', async () => {
  const config = makeConfig({ validateResponseSign: true });
  const store = new OrderStore({ filePath: ':memory:' });
  await store.init();

  const sdk = makingSdk({
    errorResponse: {
      code: '40002',
      msg: 'Invalid Arguments',
      sub_code: 'isv.invalid-app-id',
      sub_msg: '无效的AppID参数',
    },
  });

  const first = await handleResourceRequest({
    paymentProofHeader: undefined,
    config,
    sdk,
    store,
    resourceId: config.resourcePath,
    logger: silentLogger,
  });
  assert.equal(first.status, 402);

  const res = await handleResourceRequest({
    paymentProofHeader: makeProofHeader(),
    config,
    sdk,
    store,
    resourceId: config.resourcePath,
    logger: silentLogger,
  });

  // 关键：必须把支付宝的真实错误码透出来，而不是 500 VERIFY_FAILED
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'isv.invalid-app-id');
  assert.equal(res.body.message, '无效的AppID参数');
});
