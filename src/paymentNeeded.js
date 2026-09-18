'use strict';

/**
 * 402 Payment-Needed 构造
 *
 * 依据《A2M 智能收产品对接文档》四、4.2：
 *   首次请求（无 Payment-Proof）时返回 HTTP 402，
 *   响应头 Payment-Needed = Base64URL(JSON)，结构分层为 protocol / method。
 *
 * 分层与字段职责：
 *   protocol —— 交易要素 + 商家签名（消费者据此发起支付）
 *   method   —— 收款方身份与商品信息（消费者据此识别向谁付款、买什么）
 */

const { buildSignContent, signRsa2, base64UrlEncode, formatIso8601WithTimezone } = require('./signing');

/**
 * 参与商家签名的字段（与官方示例一致，不可随意增减）：
 *   amount, currency, goods_name, out_trade_no, pay_before, resource_id, seller_id, service_id
 *
 * 注意 seller_name / seller_app_id / seller_unique_id_key 不参与签名，
 * 与示例代码保持一致。
 */
const SIGNED_FIELDS = [
  'amount',
  'currency',
  'goods_name',
  'out_trade_no',
  'pay_before',
  'resource_id',
  'seller_id',
  'service_id',
];

/**
 * 计算商家签名
 * @param {object} order 订单要素
 * @param {string} privateKey PKCS#1 PEM
 * @returns {string} Base64 签名
 */
function computeSellerSignature(order, privateKey) {
  const params = {};
  for (const field of SIGNED_FIELDS) {
    params[field] = order[field];
  }
  const content = buildSignContent(params);
  return signRsa2(content, privateKey);
}

/**
 * 构造 Payment-Needed 载荷
 *
 * @param {object} args
 * @param {object} args.config 应用配置
 * @param {string} args.outTradeNo 商户订单号
 * @param {string} args.resourceId 资源ID
 * @param {string} [args.goodsName] 商品名称，默认取配置
 * @param {string} [args.amount] 金额（元），默认取配置
 * @param {Date}   [args.now] 当前时间，默认 new Date()
 * @returns {{payload:object, header:string, order:object}}
 */
function buildPaymentNeeded({ config, outTradeNo, resourceId, goodsName, amount, now }) {
  const finalAmount = amount ?? config.amount;
  const finalGoodsName = goodsName ?? config.goodsName;

  const payBeforeDate = new Date(
    (now ? now.getTime() : Date.now()) + config.payBeforeMinutes * 60 * 1000,
  );
  const payBefore = formatIso8601WithTimezone(payBeforeDate);

  const order = {
    out_trade_no: outTradeNo,
    amount: finalAmount,
    currency: config.currency,
    resource_id: resourceId,
    pay_before: payBefore,
    seller_id: config.sellerId,
    service_id: config.serviceId,
    goods_name: finalGoodsName,
  };

  const sellerSignature = computeSellerSignature(order, config.appPrivateKey);

  const payload = {
    protocol: {
      out_trade_no: order.out_trade_no,
      amount: order.amount,
      currency: order.currency,
      resource_id: order.resource_id,
      pay_before: order.pay_before,
      seller_signature: sellerSignature,
      seller_sign_type: config.signType,
      seller_unique_id: config.sellerId,
    },
    method: {
      seller_name: config.sellerName,
      seller_id: config.sellerId,
      seller_app_id: config.appId,
      goods_name: order.goods_name,
      seller_unique_id_key: 'seller_id',
      service_id: config.serviceId,
    },
  };

  return {
    payload,
    header: base64UrlEncode(JSON.stringify(payload)),
    order,
  };
}

/**
 * 402 响应体（与文档 4.2 响应体示例字段一致）
 */
function build402Body({ outTradeNo, amount, currency, goodsName }) {
  return {
    code: 'Payment-Needed',
    message: '需要支付',
    out_trade_no: outTradeNo,
    amount,
    currency,
    goods_name: goodsName,
  };
}

module.exports = {
  SIGNED_FIELDS,
  computeSellerSignature,
  buildPaymentNeeded,
  build402Body,
};
