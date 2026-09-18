'use strict';

/**
 * 支付宝 SDK 客户端工厂
 *
 * 引入方式依据 alipay-sdk 的类型定义确认（dist/commonjs/index.d.ts）：
 *   export { AlipaySdk } from './alipay.js'  → 具名导出
 * 因此使用 `const { AlipaySdk } = require('alipay-sdk')`。
 *
 * 关键配置项（dist/commonjs/types.d.ts / AlipaySdkConfig）：
 *   keyType   'PKCS1' | 'PKCS8'，默认 PKCS1 —— 非 JAVA 语言必须 PKCS1，显式声明
 *   charset   类型仅接受小写 'utf-8'
 *   camelcase 默认 true 会把响应字段转驼峰，这里置 false 以保持与官方文档
 *             一致的 snake_case，避免字段名误判
 *   timeout   网关超时（毫秒）
 */

const { AlipaySdk } = require('alipay-sdk');
const { toSdkOptions } = require('./config');

/**
 * @param {object} config loadConfig() 的返回值
 * @returns {AlipaySdk}
 */
function createAlipayClient(config) {
  return new AlipaySdk(toSdkOptions(config));
}

module.exports = { createAlipayClient };
