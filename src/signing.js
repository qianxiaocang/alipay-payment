'use strict';

/**
 * 签名与编码工具
 *
 * 对应 A2M 智能收对接文档：
 *   - 四、4.2  Payment-Needed Header 为 Base64URL 编码的 JSON
 *   - 七、4    支付截止时间使用 ISO 8601 带时区偏移（如 2026-04-15T12:54:37+08:00）
 *   - 五、5.4  商家签名：按 key 字典序排序 → 拼接 k=v&... → RSA2 签名 → Base64
 *
 * ⚠️ 与「传统收单产品」的区别（SKILL.md 步骤 1.4 自检第 4 项）：
 *   传统支付接口的时间戳用 `yyyy-MM-dd HH:mm:ss`；
 *   AI 收的 pay_before 用 ISO 8601 带时区。两者不可混用。
 */

const crypto = require('crypto');

/**
 * 构造待签名字符串。
 *
 * 规则（与官方示例保持一致）：
 *   1. 按 key 字典序排序
 *   2. 跳过 null / undefined / 空字符串
 *   3. 以 `key=value` 形式用 & 连接
 *
 * 注意：过滤发生在拼接阶段，因此值为空串的字段不会留下多余的 &
 *
 * @param {Record<string, string|number|null|undefined>} params
 * @returns {string}
 */
function buildSignContent(params) {
  return Object.keys(params)
    .filter((key) => {
      const v = params[key];
      return v !== null && v !== undefined && String(v) !== '';
    })
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

/**
 * RSA2（SHA256withRSA）签名，返回 Base64
 *
 * @param {string} signContent 待签名字符串
 * @param {string|crypto.KeyObject} privateKey PKCS#1 PEM 或 KeyObject
 * @returns {string} Base64 签名
 */
function signRsa2(signContent, privateKey) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signContent, 'utf8');
  signer.end();
  return signer.sign(privateKey, 'base64');
}

/**
 * RSA2 验签（用于本地测试与自检；线上以支付宝服务端验签为准）
 *
 * @param {string} signContent
 * @param {string} signatureBase64
 * @param {string|crypto.KeyObject} publicKey
 * @returns {boolean}
 */
function verifyRsa2(signContent, signatureBase64, publicKey) {
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(signContent, 'utf8');
    verifier.end();
    return verifier.verify(publicKey, signatureBase64, 'base64');
  } catch {
    return false;
  }
}

/**
 * Base64URL 编码（RFC 4648 §5：+→-、/→_、去除 = 补位）
 * @param {string} input
 * @returns {string}
 */
function base64UrlEncode(input) {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Base64URL 解码（容错：自动补齐 padding，兼容标准 Base64 字符）
 * @param {string} input
 * @returns {string} UTF-8 字符串
 */
function base64UrlDecode(input) {
  let str = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const remainder = str.length % 4;
  if (remainder === 1) {
    throw new Error('Base64URL 长度非法');
  }
  if (remainder) {
    str += '='.repeat(4 - remainder);
  }
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * 格式化为 ISO 8601 带时区偏移量，例如 2026-04-15T12:54:37+08:00
 *
 * 使用服务器本地时间并附带本地时区偏移，符合文档要求。
 *
 * @param {Date} [date]
 * @returns {string}
 */
function formatIso8601WithTimezone(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  // getTimezoneOffset 返回「UTC - 本地」的分钟数，取反得到本地相对 UTC 的偏移
  const offsetMinutesTotal = -date.getTimezoneOffset();
  const sign = offsetMinutesTotal >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutesTotal);
  const offsetHours = pad(Math.floor(abs / 60));
  const offsetMinutes = pad(abs % 60);

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetMinutes}`;
}

/**
 * 生成商户订单号。
 * 支付宝 out_trade_no 要求全局唯一且长度受限，这里用时间戳 + 随机数保证唯一。
 * @returns {string}
 */
function generateOutTradeNo() {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `ORDER_${ts}_${rand}`;
}

module.exports = {
  buildSignContent,
  signRsa2,
  verifyRsa2,
  base64UrlEncode,
  base64UrlDecode,
  formatIso8601WithTimezone,
  generateOutTradeNo,
};
