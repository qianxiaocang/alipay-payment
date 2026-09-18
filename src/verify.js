'use strict';

/**
 * 支付凭证校验 + 履约回执
 *
 * 对应《A2M 智能收产品对接文档》四、4.3 与 五、5.2 / 5.3：
 *   - alipay.aipay.agent.payment.verify        校验支付凭证
 *   - alipay.aipay.agent.fulfillment.confirm   上报履约回执
 *
 * 文档「七、注意事项 6」特别强调：
 *   client_session 由 C 端 Agent 通过支付宝 CLI 生成，
 *   商家必须从 Payment-Proof 中原样提取并透传，不得修改、缓存或自行构造，
 *   否则会导致校验失败。本文件严格按此实现。
 */

const { base64UrlDecode, base64UrlEncode } = require('./signing');

/** 校验失败原因 → 对外错误码（与文档「六、错误码说明」一致） */
const ERR = {
  INVALID_PAYMENT_PROOF_FORMAT: 'INVALID_PAYMENT_PROOF_FORMAT',
  INVALID_PAYMENT_PROOF: 'INVALID_PAYMENT_PROOF',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  RESOURCE_ID_MISMATCH: 'RESOURCE_ID_MISMATCH',
  /**
   * 网关响应缺少 resource_id。
   *
   * 官方对接文档要求：生产环境必须把资源字段缺失当作异常处理，
   * 绝不能让「字段缺失」被当作「校验通过」。单列此码是为了不与
   * RESOURCE_ID_MISMATCH（字段存在但值与订单不符）混淆，便于排查。
   */
  RESOURCE_ID_MISSING: 'RESOURCE_ID_MISSING',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  VERIFY_FAILED: 'VERIFY_FAILED',
  FULFILLMENT_CONFIRM_FAILED: 'FULFILLMENT_CONFIRM_FAILED',
};

/**
 * 判断网关返回的字段是否「有值」。
 * 空字符串与仅空白字符串都视为缺失 —— 沙箱与网关异常都可能返回空串。
 */
function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/** 业务异常，携带对外错误码与 HTTP 状态 */
class PaymentError extends Error {
  constructor(code, message, httpStatus = 400, extra = {}) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.httpStatus = httpStatus;
    Object.assign(this, extra);
  }
}

/**
 * 容错取值：SDK 的 camelcase 配置会影响响应字段名，
 * 这里同时兼容 snake_case 与 camelCase，避免因配置差异读不到字段。
 */
function pick(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  }
  return undefined;
}

/**
 * 解析 Payment-Proof Header
 *
 * 结构（Base64URL(JSON)）：
 *   { protocol: { payment_proof, trade_no }, method: { client_session } }
 *
 * @param {string} headerValue
 * @returns {{paymentProof:string, tradeNo:string, clientSession:string, raw:object}}
 */
function parsePaymentProof(headerValue) {
  if (!headerValue || !String(headerValue).trim()) {
    throw new PaymentError(ERR.INVALID_PAYMENT_PROOF_FORMAT, 'Payment-Proof 为空');
  }

  let parsed;
  try {
    parsed = JSON.parse(base64UrlDecode(String(headerValue).trim()));
  } catch (err) {
    throw new PaymentError(
      ERR.INVALID_PAYMENT_PROOF_FORMAT,
      `Payment-Proof 格式错误：Base64URL 解码或 JSON 解析失败（${err.message}）`,
    );
  }

  const protocol = parsed.protocol || {};
  const method = parsed.method || {};

  // 官方结构在 protocol 层；同时容忍字段被平铺在顶层的情况
  const paymentProof = pick(protocol, 'payment_proof', 'paymentProof') ?? pick(parsed, 'payment_proof', 'paymentProof');
  const tradeNo = pick(protocol, 'trade_no', 'tradeNo') ?? pick(parsed, 'trade_no', 'tradeNo');
  const clientSession = pick(method, 'client_session', 'clientSession') ?? pick(parsed, 'client_session', 'clientSession');

  if (!paymentProof || !String(paymentProof).trim()) {
    throw new PaymentError(ERR.INVALID_PAYMENT_PROOF_FORMAT, 'Payment-Proof 格式错误：缺少 payment_proof');
  }
  if (!tradeNo || !String(tradeNo).trim()) {
    throw new PaymentError(ERR.INVALID_PAYMENT_PROOF_FORMAT, 'Payment-Proof 格式错误：缺少 trade_no');
  }
  if (!clientSession || !String(clientSession).trim()) {
    throw new PaymentError(ERR.INVALID_PAYMENT_PROOF_FORMAT, 'Payment-Proof 格式错误：缺少 client_session');
  }

  return {
    paymentProof: String(paymentProof),
    tradeNo: String(tradeNo),
    clientSession: String(clientSession),
    raw: parsed,
  };
}

/**
 * 调用支付宝校验支付凭证
 *
 * 说明：bizContent 使用 snake_case。已用 sdkExec 实测确认 SDK 会把
 * bizContent 原样序列化到线上（不会自动转驼峰），因此这里必须用 snake_case。
 *
 * @param {object} args
 * @param {import('alipay-sdk').AlipaySdk} args.sdk
 * @param {string} args.paymentProof
 * @param {string} args.tradeNo
 * @param {string} args.clientSession
 * @param {boolean} [args.validateSign]
 * @returns {Promise<object>} 归一化后的校验结果
 */
async function callPaymentVerify({ sdk, paymentProof, tradeNo, clientSession, validateSign = true }) {
  const { response, signatureValidated } = await execGateway({
    sdk,
    method: 'alipay.aipay.agent.payment.verify',
    bizContent: { payment_proof: paymentProof, trade_no: tradeNo, client_session: clientSession },
    validateSign,
  });

  if (!signatureValidated) {
    // 走的是无签名响应降级路径：只用于读取错误码，绝不能当作成功
    console.warn('[aipay] 网关返回无签名响应，已降级为不验签以读取错误码');
  }

  return {
    raw: response,
    signatureValidated,
    code: pick(response, 'code'),
    subCode: pick(response, 'sub_code', 'subCode'),
    subMsg: pick(response, 'sub_msg', 'subMsg'),
    active: pick(response, 'active'),
    tradeNo: pick(response, 'trade_no', 'tradeNo'),
    outTradeNo: pick(response, 'out_trade_no', 'outTradeNo'),
    resourceId: pick(response, 'resource_id', 'resourceId'),
    amount: pick(response, 'amount'),
    traceId: pick(response, 'traceId', 'trace_id'),
  };
}

/**
 * 上报履约回执
 *
 * @param {object} args
 * @param {import('alipay-sdk').AlipaySdk} args.sdk
 * @param {string} args.tradeNo
 * @param {boolean} [args.validateSign]
 * @returns {Promise<{ok:boolean, code?:string, subCode?:string, subMsg?:string}>}
 */
async function callFulfillmentConfirm({ sdk, tradeNo, validateSign = true }) {
  const { response } = await execGateway({
    sdk,
    method: 'alipay.aipay.agent.fulfillment.confirm',
    bizContent: { trade_no: tradeNo },
    validateSign,
  });

  const code = pick(response, 'code');
  return {
    ok: code === '10000',
    code,
    subCode: pick(response, 'sub_code', 'subCode'),
    subMsg: pick(response, 'sub_msg', 'subMsg'),
  };
}

/** 金额比较：容忍 "0.01" / "0.010" / 0.01 等表示差异 */
function amountEquals(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return String(a) === String(b);
  // 以分为单位比较整数，避免浮点误差
  return Math.round(na * 100) === Math.round(nb * 100);
}

/**
 * 识别「网关返回了无签名响应」这一特定故障。
 *
 * 背景（实测确认）：alipay-sdk 的 checkResponseSign 会【无条件】执行验签，
 * 即使网关返回的是 error_response（无 sign 字段）。此时 serverSign 为 undefined，
 * Node 的 crypto.verify 会抛出：
 *   TypeError: The "signature" argument must be of type string ...
 *
 * 后果非常严重：所有网关级错误（isv.invalid-app-id、isv.invalid-signature 等）
 * 都会被这个无意义的 crypto 报错掩盖，而这恰恰是首次接入时最需要看到的报错。
 *
 * 注意：必须与「真的验签失败」（AlipayRequestError: 验签失败…）严格区分——
 * 后者是安全信号，绝不能重试或忽略。
 */
function isUnsignedResponseError(err) {
  return (
    err instanceof TypeError &&
    /signature.*must be of type string/i.test(err.message)
  );
}

/**
 * 调用网关，并在遇到「无签名响应」时安全降级。
 *
 * 安全设计：
 *   降级重试只用于【取回真实错误码】，绝不采信未验签的成功响应。
 *   若未验签的响应返回 code=10000，说明可能是伪造，直接拒绝。
 *
 * @returns {Promise<{response:object, signatureValidated:boolean}>}
 */
async function execGateway({ sdk, method, bizContent, validateSign }) {
  try {
    const response = await sdk.exec(method, { bizContent }, { validateSign });
    return { response, signatureValidated: Boolean(validateSign) };
  } catch (err) {
    if (!validateSign || !isUnsignedResponseError(err)) throw err;

    // 网关返回了无签名响应，重发一次以取回真实错误信息
    const retry = await sdk.exec(method, { bizContent }, { validateSign: false });

    if (retry && retry.code === '10000') {
      // 未验签却报成功 —— 拒绝采信
      const forged = new Error('网关返回了未签名的成功响应，出于安全考虑拒绝采信');
      forged.code = 'UNSIGNED_SUCCESS_REJECTED';
      throw forged;
    }

    return { response: retry, signatureValidated: false };
  }
}

/**
 * 构造 Payment-Validation Header
 * 字段依据文档 4.3：trade_no / out_trade_no / validated / resource_id
 */
function buildPaymentValidation({ tradeNo, outTradeNo, resourceId }) {
  return base64UrlEncode(
    JSON.stringify({
      trade_no: tradeNo,
      out_trade_no: outTradeNo,
      validated: true,
      resource_id: resourceId,
    }),
  );
}

module.exports = {
  ERR,
  PaymentError,
  parsePaymentProof,
  callPaymentVerify,
  callFulfillmentConfirm,
  buildPaymentValidation,
  amountEquals,
  pick,
  hasValue,
  execGateway,
  isUnsignedResponseError,
};
