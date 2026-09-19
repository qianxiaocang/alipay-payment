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
 *       → 资源ID防串校验 → 金额校验
 *       → 两阶段履约（占位生成资源 → 认领并上报回执）→ 200 + Payment-Validation
 *
 * 其中「订单查询 / 资源ID防串 / 幂等占位」在官方示例中是【TODO】注释，
 * 这里已落地为真实实现（详见 src/repository/ 的说明）。
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
const { createStaticProvider } = require('./resource');
const { fingerprint } = require('./requestContext');
const { STATUS } = require('./repository/contract');

/** 未显式提供资源生成器时的兜底（仅占位内容，用于跑通链路与测试） */
const fallbackResourceProvider = createStaticProvider();

/**
 * 处理一次资源请求
 *
 * @param {object} args
 * @param {string|undefined} args.paymentProofHeader 请求头 Payment-Proof
 * @param {object} args.config
 * @param {import('alipay-sdk').AlipaySdk} args.sdk
 * @param {import('./repository').JsonFileOrderRepository|import('./repository').SqlOrderRepository} args.repository
 * @param {string} args.resourceId 本次请求的资源ID
 * @param {(ctx:object)=>string} [args.generateResource]
 * @param {{info:Function, warn:Function, error:Function}} [args.logger]
 * @returns {Promise<{status:number, headers:Record<string,string>, body:object}>}
 */
async function handleResourceRequest({
  paymentProofHeader,
  config,
  sdk,
  repository,
  resourceId,
  requestContext = null,
  generateResource = fallbackResourceProvider,
  logger = console,
}) {
  const hasProof = Boolean(paymentProofHeader && String(paymentProofHeader).trim());
  return hasProof
    ? handlePaidRequest({ paymentProofHeader, config, sdk, repository, resourceId, requestContext, generateResource, logger })
    : handleInitialRequest({ config, repository, resourceId, requestContext, logger });
}

// ---------------------------------------------------------------- 场景一

/**
 * 首次请求：本地构造订单并返回 402
 */
async function handleInitialRequest({ config, repository, resourceId, requestContext, logger }) {
  const outTradeNo = generateOutTradeNo();

  // 记录「被收费的那次请求」的指纹，二次请求时比对。
  // 402 协议本身无法承载载荷哈希，所以绑定只能在服务端做（详见 requestContext.js）。
  const payloadFingerprint = config.bindPayload && requestContext
    ? fingerprint(requestContext)
    : null;

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
    await repository.create({
      outTradeNo,
      resourceId,
      amount: built.order.amount,
      payBefore: built.order.pay_before,
      goodsName: built.order.goods_name,
      currency: built.order.currency,
      payloadFingerprint,
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
  repository,
  resourceId,
  requestContext,
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
  //    注意：验付成功只代表支付宝凭证有效，不代表本地订单已匹配成功。
  const outTradeNo = result.outTradeNo;
  const tradeNo = result.tradeNo || proof.tradeNo;
  const order = outTradeNo ? await repository.get(outTradeNo) : null;
  if (!order) {
    logger.warn('[aipay] 订单不存在 out_trade_no=%s', outTradeNo);
    return {
      status: 404,
      headers: {},
      body: { code: ERR.ORDER_NOT_FOUND, message: '订单不存在' },
    };
  }

  // 5.1 载荷绑定校验
  //     攻击场景：用一个便宜/无害的请求拿到 402 并付款 0.01，
  //     然后带着同一份 Payment-Proof 重放一个**完全不同、成本高得多**的请求。
  //     凭证是有效的，若不绑定载荷就会被放行 —— 等于低价买了高价调用。
  //     402 协议没有可承载载荷哈希的字段，因此绑定只能在服务端完成。
  if (config.bindPayload && order.payload_fingerprint) {
    const current = requestContext ? fingerprint(requestContext) : null;
    if (!current || current !== order.payload_fingerprint) {
      logger.error(
        '[aipay] 请求载荷与下单时不一致，拒绝执行 out_trade_no=%s（当前指纹 %s）',
        outTradeNo,
        current ? current.slice(0, 12) : '不可用',
      );
      return {
        status: 409,
        headers: {},
        body: {
          code: ERR.PAYLOAD_MISMATCH,
          message: '本次请求内容与下单时不一致，已拒绝执行；请重新发起并完成支付',
        },
      };
    }
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

  // 8. 资源生成：认领（快、原子）→ 生成（慢、锁外）→ 落库（快、原子）
  //
  //    为什么不能像早期实现那样「持锁期间生成」：对「API 按次付费」而言
  //    生成 = 调用后端业务 API，是数秒级的慢操作。持锁做 I/O 会让 JSON 实现
  //    阻塞整个服务、让 SQL 实现长期占住行锁与连接池。
  //    因此用【生成租约】保证「同一订单只有一个执行者真的去调业务 API」，
  //    且持有者崩溃后租约过期可被接管。
  let outcome = null;
  try {
    outcome = await repository.claimFulfillmentGeneration({
      outTradeNo,
      leaseMs: config.generateLeaseMs,
    });
  } catch (err) {
    logger.error('[aipay] 认领资源生成权失败 out_trade_no=%s: %s', outTradeNo, err.message);
    return {
      status: 500,
      headers: {},
      body: { code: 'FULFILLMENT_ERROR', message: '履约处理失败' },
    };
  }

  const paymentValidation = buildPaymentValidation({
    tradeNo,
    outTradeNo,
    resourceId: order.resource_id,
  });

  const alreadyFulfilledResponse = (serviceResult) => ({
    status: 200,
    headers: { 'Payment-Validation': paymentValidation },
    body: {
      code: 'ALREADY_FULFILLED',
      message: '订单已履约，不重复提供',
      resource_id: order.resource_id,
      content: serviceResult,
      trade_no: tradeNo,
      out_trade_no: outTradeNo,
      already_fulfilled: true,
    },
  });

  if (outcome.state === 'NOT_FOUND') {
    logger.warn('[aipay] 订单不存在 out_trade_no=%s', outTradeNo);
    return {
      status: 404,
      headers: {},
      body: { code: ERR.ORDER_NOT_FOUND, message: '订单不存在' },
    };
  }

  // 已闭环（含并发/多实例的后来者）：复用已落库资源，不重复生成、不重复上报
  if (outcome.state === STATUS.FULFILLED) {
    logger.info('[aipay] 订单已履约，复用已落库资源 out_trade_no=%s', outTradeNo);
    return alreadyFulfilledResponse(outcome.serviceResult);
  }

  let serviceResult = outcome.serviceResult;

  // 资源尚未生成：本次拿到生成权则去生成，否则说明他人正在生成
  if (outcome.state === 'CLAIMED') {
    try {
      serviceResult = await generateResource({
        resourceId: order.resource_id,
        outTradeNo,
        tradeNo,
        request: requestContext,
      });
    } catch (err) {
      // 生成失败：释放生成权，订单留在可重试态，且【不得】上报履约回执
      logger.error('[aipay] 生成资源失败 out_trade_no=%s: %s', outTradeNo, err.message);
      try {
        await repository.releaseFulfillmentGeneration({ outTradeNo });
      } catch (releaseErr) {
        logger.warn('[aipay] 释放生成权失败 out_trade_no=%s: %s', outTradeNo, releaseErr.message);
      }
      return {
        status: 500,
        headers: {},
        body: { code: 'FULFILLMENT_ERROR', message: '履约处理失败' },
      };
    }

    if (!hasValue(serviceResult)) {
      logger.error('[aipay] 资源生成返回空内容 out_trade_no=%s', outTradeNo);
      try {
        await repository.releaseFulfillmentGeneration({ outTradeNo });
      } catch { /* 已在上面记录过失败原因 */ }
      return {
        status: 500,
        headers: {},
        body: { code: 'FULFILLMENT_ERROR', message: '履约处理失败' },
      };
    }

    try {
      const stored = await repository.storeFulfillmentResult({ outTradeNo, tradeNo, serviceResult });
      // 落库时若已有资源（并发下他人先写入），以已落库的为准
      if (stored && hasValue(stored.service_result)) serviceResult = stored.service_result;
    } catch (err) {
      logger.error('[aipay] 资源落库失败 out_trade_no=%s: %s', outTradeNo, err.message);
      return {
        status: 500,
        headers: {},
        body: { code: 'FULFILLMENT_ERROR', message: '履约处理失败' },
      };
    }
  } else if (outcome.state === 'IN_PROGRESS') {
    // 他人正在生成：有界等待其落库
    const settled = await waitForGenerated(repository, outTradeNo, config.confirmWaitMs);
    if (settled && hasValue(settled.service_result)) {
      serviceResult = settled.service_result;
    } else {
      logger.warn('[aipay] 资源正在由其他执行者生成 out_trade_no=%s', outTradeNo);
      return {
        status: 502,
        headers: {},
        body: {
          code: ERR.FULFILLMENT_CONFIRM_FAILED,
          message: '履约正在处理中，请稍后使用同一 Payment-Proof 重试',
        },
      };
    }
  }

  if (!hasValue(serviceResult)) {
    logger.error('[aipay] 未能取得可用资源 out_trade_no=%s', outTradeNo);
    return {
      status: 500,
      headers: {},
      body: { code: 'FULFILLMENT_ERROR', message: '履约处理失败' },
    };
  }

  // 9. 两阶段履约 · 第二步：认领回执上报权后再上报
  //    认领是跨实例原子操作（SQL 用 UPDATE + 租约），保证同一订单同一时刻
  //    只有一个执行者会调用支付宝，避免重复上报。
  let claimed;
  try {
    claimed = await repository.claimFulfillmentConfirm({
      outTradeNo,
      leaseMs: config.confirmLeaseMs,
    });
  } catch (err) {
    logger.error('[aipay] 认领回执上报权失败 out_trade_no=%s: %s', outTradeNo, err.message);
    return {
      status: 502,
      headers: {},
      body: {
        code: ERR.FULFILLMENT_CONFIRM_FAILED,
        message: '资源已生成但暂时无法确认履约，请稍后使用同一 Payment-Proof 重试',
      },
    };
  }

  if (!claimed) {
    // 另一执行者正在上报：短暂等待其收敛，避免给买家无谓的失败
    const settled = await waitForFulfilled(repository, outTradeNo, config.confirmWaitMs);
    if (settled) {
      logger.info('[aipay] 回执由其他执行者完成，复用结果 out_trade_no=%s', outTradeNo);
      return alreadyFulfilledResponse(settled.service_result ?? serviceResult);
    }
    logger.warn('[aipay] 回执正在被其他执行者上报中 out_trade_no=%s', outTradeNo);
    return {
      status: 502,
      headers: {},
      body: {
        code: ERR.FULFILLMENT_CONFIRM_FAILED,
        message: '履约确认正在处理中，请稍后使用同一 Payment-Proof 重试',
      },
    };
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

  if (!confirmResult.ok) {
    // 释放认领：订单留在 PENDING_CONFIRM，资源复用，等待同一凭证重试
    try {
      await repository.releaseFulfillmentClaim({
        outTradeNo,
        code: confirmResult.code,
        subCode: confirmResult.subCode,
        subMsg: confirmResult.subMsg,
      });
    } catch (err) {
      logger.warn('[aipay] 释放回执认领失败 out_trade_no=%s: %s', outTradeNo, err.message);
    }

    logger.error(
      '[aipay] 履约回执上报失败，资源已生成但未确认交付 out_trade_no=%s code=%s sub_code=%s',
      outTradeNo,
      confirmResult.code,
      confirmResult.subCode,
    );
    return {
      status: 502,
      headers: {},
      body: {
        code: ERR.FULFILLMENT_CONFIRM_FAILED,
        message: '资源已生成但履约确认失败，请稍后使用同一 Payment-Proof 重试',
      },
    };
  }

  // 回执确认成功，订单闭环
  await repository.completeFulfillment({ outTradeNo, tradeNo });
  logger.info('[aipay] 履约成功 out_trade_no=%s trade_no=%s', outTradeNo, tradeNo);

  // 11. 返回资源 + Payment-Validation
  return {
    status: 200,
    headers: { 'Payment-Validation': paymentValidation },
    body: {
      resource_id: order.resource_id,
      content: serviceResult,
      trade_no: tradeNo,
      out_trade_no: outTradeNo,
      already_fulfilled: false,
    },
  };
}

// ---------------------------------------------------------------- 工具

/**
 * 等待「其他执行者」把回执确认完成。
 *
 * 场景：本请求没能拿到回执认领权，说明另一个执行者（可能是另一个实例）
 * 正在上报。此时立刻返回 502 虽然协议上合法（买家可重试），但对买家不友好。
 * 这里做一次有界轮询：若对方很快完成，就直接复用其结果返回成功。
 *
 * @param {object} repository
 * @param {string} outTradeNo
 * @param {number} timeoutMs 最长等待时间
 * @returns {Promise<object|null>} 已闭环的订单（含 service_result），超时返回 null
 */
async function waitForFulfilled(repository, outTradeNo, timeoutMs) {
  return waitForOrderState(repository, outTradeNo, timeoutMs, (o) => o.status === STATUS.FULFILLED);
}

/**
 * 等待「其他执行者」把资源生成并落库。
 *
 * 场景：本请求没拿到生成权（IN_PROGRESS），说明另一个执行者（可能是另一个实例）
 * 正在调用业务 API。这里做有界轮询，对方落库后直接复用其结果。
 *
 * @returns {Promise<object|null>}
 */
async function waitForGenerated(repository, outTradeNo, timeoutMs) {
  return waitForOrderState(repository, outTradeNo, timeoutMs, (o) => hasValue(o.service_result));
}

/**
 * 有界轮询订单直到满足条件或超时。读取抖动不打断等待，交由超时处理。
 *
 * @param {(order:object)=>boolean} predicate
 * @returns {Promise<object|null>}
 */
async function waitForOrderState(repository, outTradeNo, timeoutMs, predicate) {
  if (!timeoutMs || timeoutMs <= 0) return null;
  const deadline = Date.now() + timeoutMs;
  const intervalMs = 25;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const current = await repository.get(outTradeNo);
      if (current && predicate(current)) return current;
    } catch {
      // 忽略读取抖动，继续等待
    }
  }
  return null;
}

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
