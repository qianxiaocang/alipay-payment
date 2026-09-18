'use strict';

/**
 * AI 收核心流程编排
 *
 * 把 HTTP 层与业务逻辑分离，便于在不启动服务器的情况下做端到端测试。
 *
 * 完整流程（对应文档 2.2 接口处理流程图）：
 *
 *   场景一（无 Payment-Proof）
 *     构造订单 → 商家签名 → 构造 Payment-Needed → 402
 *
 *   场景二（有 Payment-Proof）
 *     解析凭证 → 校验凭证 → active 校验 → 订单查询
 *       → 资源ID防串校验 → 金额校验 → 幂等占位
 *       → 生成资源 → 上报履约回执 → 200 + Payment-Validation
 *
 * 其中「订单查询 / 资源ID防串 / 幂等占位」在官方示例中是【TODO】注释，
 * 这里已落地为真实实现（详见 store.js 的说明）。
 */

const {
  buildPaymentNeeded,
  build402Body,
} = require('./paymentNeeded');
const {
  ERR,
  PaymentError,
  parsePaymentProof,
  callPaymentVerify,
  callFulfillmentConfirm,
  buildPaymentValidation,
  amountEquals,
  hasValue,
} = require('./verify');
const { generateOutTradeNo } = require('./signing');
const { generateDefaultResource } = require('./resource');
const { STATUS } = require('./store');

/**
 * 处理一次资源请求
 *
 * @param {object} args
 * @param {string|undefined} args.paymentProofHeader 请求头 Payment-Proof
 * @param {object} args.config
 * @param {import('alipay-sdk').AlipaySdk} args.sdk
 * @param {import('./store').OrderStore} args.store
 * @param {string} args.resourceId 本次请求的资源ID
 * @param {(ctx:object)=>string} [args.generateResource]
 * @param {{info:Function, warn:Function, error:Function}} [args.logger]
 * @returns {Promise<{status:number, headers:Record<string,string>, body:object}>}
 */
async function handleResourceRequest({
  paymentProofHeader,
  config,
  sdk,
  store,
  resourceId,
  generateResource = generateDefaultResource,
  logger = console,
}) {
  const hasProof = Boolean(paymentProofHeader && String(paymentProofHeader).trim());
  return hasProof
    ? handlePaidRequest({ paymentProofHeader, config, sdk, store, resourceId, generateResource, logger })
    : handleInitialRequest({ config, store, resourceId, logger });
}

// ---------------------------------------------------------------- 场景一

/**
 * 首次请求：本地构造订单并返回 402
 */
async function handleInitialRequest({ config, store, resourceId, logger }) {
  const outTradeNo = generateOutTradeNo();

  let built;
  try {
    built = buildPaymentNeeded({ config, outTradeNo, resourceId });
  } catch (err) {
    logger.error('[aipay] 构造支付请求失败: %s', err.message);
    return {
      status: 500,
      headers: {},
      body: { code: 'SIGN_ERROR', message: '构造支付请求失败' },
    };
  }

  try {
    await store.create({
      outTradeNo,
      resourceId,
      amount: built.order.amount,
      payBefore: built.order.pay_before,
      goodsName: built.order.goods_name,
    });
  } catch (err) {
    logger.error('[aipay] 创建订单失败: %s', err.message);
    return {
      status: 500,
      headers: {},
      body: { code: 'CREATE_ORDER_ERROR', message: '创建订单失败' },
    };
  }

  logger.info('[aipay] 已创建待支付订单 out_trade_no=%s', outTradeNo);

  return {
    status: 402,
    headers: { 'Payment-Needed': built.header },
    body: build402Body({
      outTradeNo,
      amount: built.order.amount,
      currency: built.order.currency,
      goodsName: built.order.goods_name,
    }),
  };
}

// ---------------------------------------------------------------- 场景二

/**
 * 二次请求：校验凭证并履约
 */
async function handlePaidRequest({
  paymentProofHeader,
  config,
  sdk,
  store,
  resourceId,
  generateResource,
  logger,
}) {
  // 1. 解析 Payment-Proof
  let proof;
  try {
    proof = parsePaymentProof(paymentProofHeader);
  } catch (err) {
    return errorResponse(err, logger);
  }

  // 2. 调用支付宝校验凭证（client_session 原样透传）
  let result;
  try {
    result = await callPaymentVerify({
      sdk,
      paymentProof: proof.paymentProof,
      tradeNo: proof.tradeNo,
      clientSession: proof.clientSession,
      validateSign: config.validateResponseSign,
    });
  } catch (err) {
    logger.error('[aipay] 支付凭证校验调用异常: %s', err.message);
    return {
      status: 500,
      headers: {},
      body: { code: ERR.VERIFY_FAILED, message: '支付凭证校验失败' },
    };
  }

  // 3. 业务码校验
  if (result.code !== '10000') {
    logger.warn(
      '[aipay] 支付凭证校验未通过 code=%s sub_code=%s',
      result.code,
      result.subCode,
    );
    return {
      status: 400,
      headers: {},
      body: {
        code: result.subCode || ERR.INVALID_PAYMENT_PROOF,
        message: result.subMsg || '支付凭证校验未通过',
      },
    };
  }

  // 4. active 校验
  if (result.active !== true) {
    logger.warn('[aipay] 支付凭证无效或已过期 out_trade_no=%s', result.outTradeNo);
    return {
      status: 400,
      headers: {},
      body: { code: ERR.INVALID_PAYMENT_PROOF, message: '支付凭证无效或已过期' },
    };
  }

  // 5. 订单查询（以本地订单为准）
  const outTradeNo = result.outTradeNo;
  const tradeNo = result.tradeNo || proof.tradeNo;
  const order = outTradeNo ? store.get(outTradeNo) : null;
  if (!order) {
    logger.warn('[aipay] 订单不存在 out_trade_no=%s', outTradeNo);
    return {
      status: 404,
      headers: {},
      body: { code: ERR.ORDER_NOT_FOUND, message: '订单不存在' },
    };
  }

  // 6. 资源ID防串校验
  //    响应里的 resource_id 必须存在，且与本地订单、本次请求三者一致。
  //    ⚠️ 官方对接文档要求「生产环境必须把资源字段缺失当作异常处理」——
  //    字段缺失绝不能被当作校验通过。原实现写的是「存在才比较」，
  //    等于给伪造/异常响应留了一个直接绕过防串校验的口子，这里修正为硬失败。
  if (!hasValue(result.resourceId)) {
    logger.error('[aipay] 网关响应缺少 resource_id，按异常处理 out_trade_no=%s', outTradeNo);
    return {
      status: 502,
      headers: {},
      body: {
        code: ERR.RESOURCE_ID_MISSING,
        message: '网关响应缺少资源标识，无法确认资源归属，已拒绝交付',
      },
    };
  }
  if (String(result.resourceId) !== String(order.resource_id)) {
    logger.error(
      '[aipay] 资源ID不匹配（疑似资源串改）out_trade_no=%s 期望=%s 实际=%s',
      outTradeNo,
      order.resource_id,
      result.resourceId,
    );
    return {
      status: 403,
      headers: {},
      body: { code: ERR.RESOURCE_ID_MISMATCH, message: '资源 ID 不匹配，可能存在资源串改风险' },
    };
  }
  if (String(order.resource_id) !== String(resourceId)) {
    logger.error(
      '[aipay] 请求资源与订单资源不一致 out_trade_no=%s 订单=%s 请求=%s',
      outTradeNo,
      order.resource_id,
      resourceId,
    );
    return {
      status: 403,
      headers: {},
      body: { code: ERR.RESOURCE_ID_MISMATCH, message: '请求资源与订单资源不一致' },
    };
  }

  // 7. 金额校验（防御性：确保实付与下单一致）
  //    hasValue 把空串也视为缺失；金额缺失不作为放行理由，但单独走 RESOURCE_ID 之外的路径
  if (hasValue(result.amount) && !amountEquals(result.amount, order.amount)) {
    logger.error(
      '[aipay] 金额不匹配 out_trade_no=%s 期望=%s 实际=%s',
      outTradeNo,
      order.amount,
      result.amount,
    );
    return {
      status: 400,
      headers: {},
      body: { code: ERR.AMOUNT_MISMATCH, message: '订单金额与支付金额不一致' },
    };
  }

  // 8 + 9. 两阶段履约（同一订单互斥执行，避免并发重复上报回执）
  //   · 第一步 prepareFulfillment：原子占位并【只生成一次】资源，资源落库
  //   · 第二步 上报履约回执：确认成功才闭环为 FULFILLED
  //
  //   规范要求「回执上报失败不得返回成功交付，且允许用同一 Payment-Proof 重试」，
  //   因此失败时订单停留在 PENDING_CONFIRM：重试会复用已生成资源、只补发回执。
  const outcome = await store.withOrderLock(outTradeNo, async () => {
    let prepared;
    try {
      prepared = await store.prepareFulfillment({
        outTradeNo,
        tradeNo,
        createResource: () => generateResource({ resourceId: order.resource_id, outTradeNo, tradeNo }),
      });
    } catch (err) {
      logger.error('[aipay] 生成资源失败 out_trade_no=%s: %s', outTradeNo, err.message);
      return { kind: 'error' };
    }

    if (!prepared.order || !hasValue(prepared.serviceResult)) {
      logger.error('[aipay] 履约占位未返回已落库资源 out_trade_no=%s', outTradeNo);
      return { kind: 'error' };
    }

    // 已闭环（含并发后来者）：复用已落库资源，不重复生成、不重复上报
    if (prepared.state === STATUS.FULFILLED) {
      return { kind: 'already', serviceResult: prepared.serviceResult };
    }

    let confirmResult;
    try {
      confirmResult = await callFulfillmentConfirm({
        sdk,
        tradeNo,
        validateSign: config.validateResponseSign,
      });
    } catch (err) {
      confirmResult = { ok: false, code: 'EXCEPTION', subMsg: err.message };
    }

    try {
      await store.noteFulfillmentConfirm(outTradeNo, {
        ok: confirmResult.ok,
        code: confirmResult.code,
        subCode: confirmResult.subCode,
        subMsg: confirmResult.subMsg,
      });
    } catch (err) {
      logger.warn('[aipay] 记录履约回执状态失败 out_trade_no=%s: %s', outTradeNo, err.message);
    }

    if (!confirmResult.ok) {
      logger.error(
        '[aipay] 履约回执上报失败，资源已生成但未确认交付 out_trade_no=%s code=%s sub_code=%s',
        outTradeNo,
        confirmResult.code,
        confirmResult.subCode,
      );
      return { kind: 'confirm_failed' };
    }

    await store.markFulfilled(outTradeNo, tradeNo);
    logger.info('[aipay] 履约成功 out_trade_no=%s trade_no=%s', outTradeNo, tradeNo);
    return { kind: 'fulfilled', serviceResult: prepared.serviceResult };
  });

  const paymentValidation = buildPaymentValidation({
    tradeNo,
    outTradeNo,
    resourceId: order.resource_id,
  });

  if (outcome.kind === 'error') {
    return {
      status: 500,
      headers: {},
      body: { code: 'FULFILLMENT_ERROR', message: '履约处理失败' },
    };
  }

  if (outcome.kind === 'confirm_failed') {
    return {
      status: 502,
      headers: {},
      body: {
        code: ERR.FULFILLMENT_CONFIRM_FAILED,
        message: '资源已生成但履约确认失败，请稍后使用同一 Payment-Proof 重试',
      },
    };
  }

  // 已闭环：复用已落库资源
  if (outcome.kind === 'already') {
    logger.info('[aipay] 订单已履约，复用已落库资源 out_trade_no=%s', outTradeNo);
    return {
      status: 200,
      headers: { 'Payment-Validation': paymentValidation },
      body: {
        code: 'ALREADY_FULFILLED',
        message: '订单已履约，不重复提供',
        resource_id: order.resource_id,
        content: outcome.serviceResult,
        trade_no: tradeNo,
        out_trade_no: outTradeNo,
        already_fulfilled: true,
      },
    };
  }

  // 11. 返回资源 + Payment-Validation
  return {
    status: 200,
    headers: { 'Payment-Validation': paymentValidation },
    body: {
      resource_id: order.resource_id,
      content: outcome.serviceResult,
      trade_no: tradeNo,
      out_trade_no: outTradeNo,
      already_fulfilled: false,
    },
  };
}

// ---------------------------------------------------------------- 工具

function errorResponse(err, logger) {
  if (err instanceof PaymentError) {
    logger.warn('[aipay] 请求被拒: code=%s message=%s', err.code, err.message);
    return {
      status: err.httpStatus,
      headers: {},
      body: { code: err.code, message: err.message },
    };
  }
  logger.error('[aipay] 未预期错误: %s', err.message);
  return {
    status: 500,
    headers: {},
    body: { code: 'INTERNAL_ERROR', message: '服务内部错误' },
  };
}

module.exports = { handleResourceRequest };
