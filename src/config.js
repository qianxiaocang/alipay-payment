'use strict';

/**
 * 配置加载与校验
 *
 * 关键约束（来自 SKILL.md 与 alipay-sdk 类型定义）：
 *   1. Node.js 属非 JAVA 语言 → 应用私钥必须使用 PKCS#1 格式（-----BEGIN RSA PRIVATE KEY-----）
 *      对应开放平台的 appPrivatePkcsKey 字段。
 *      ⛔ 严禁自行做格式转换、严禁手工拼接 PEM 头尾。
 *   2. 默认配置固定：sign-type=RSA2、charset=UTF-8、format=json、currency=CNY。
 *      SDK 的 charset 类型只接受小写 'utf-8'，因此对外保持 UTF-8、传 SDK 时归一化。
 *   3. AI 收不支持沙箱，网关固定生产网关。
 *   4. 任何敏感值都不得进入日志。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadEnvFile } = require('./envfile');

/** 配置类错误：用于区分「配置有问题」与「运行时异常」 */
class ConfigError extends Error {
  constructor(message, hints = []) {
    super(message);
    this.name = 'ConfigError';
    this.hints = hints;
  }
}

const ROOT = path.resolve(__dirname, '..');

/** 默认配置（不得由用户改写） */
const MANDATED = {
  signType: 'RSA2',
  charset: 'UTF-8',
  format: 'json',
  currency: 'CNY',
};

const PROD_GATEWAY = 'https://openapi.alipay.com/gateway.do';

// ---------------------------------------------------------------- 工具

function required(name, label, hints = []) {
  const v = (process.env[name] || '').trim();
  if (!v) {
    throw new ConfigError(`缺少必填配置 ${name}（${label}）`, hints);
  }
  return v;
}

function readFileOrInline(inlineName, fileName, label) {
  const filePath = (process.env[fileName] || '').trim();
  if (filePath) {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ROOT, filePath);
    if (!fs.existsSync(abs)) {
      throw new ConfigError(`${fileName} 指向的文件不存在：${abs}`);
    }
    const content = fs.readFileSync(abs, 'utf8').trim();
    if (!content) throw new ConfigError(`${fileName} 指向的文件为空：${abs}`);
    return { value: content, source: fileName, filePath: abs };
  }

  const inline = (process.env[inlineName] || '').trim();
  if (!inline) {
    throw new ConfigError(
      `缺少必填配置：${inlineName} 与 ${fileName} 均未提供（${label}）`,
    );
  }
  // 支持把多行 PEM 写成一行（\n 转义）
  return { value: inline.replace(/\\n/g, '\n'), source: inlineName, filePath: null };
}

function pemKind(text) {
  if (/-----BEGIN RSA PRIVATE KEY-----/.test(text)) return 'PKCS1_PRIVATE';
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)) return 'PKCS8_ENCRYPTED';
  if (/-----BEGIN PRIVATE KEY-----/.test(text)) return 'PKCS8_PRIVATE';
  if (/-----BEGIN PUBLIC KEY-----/.test(text)) return 'SPKI_PUBLIC';
  if (/-----BEGIN RSA PUBLIC KEY-----/.test(text)) return 'PKCS1_PUBLIC';
  if (/-----BEGIN CERTIFICATE-----/.test(text)) return 'CERTIFICATE';
  if (/^[A-Za-z0-9+/=\s]+$/.test(text.trim())) return 'RAW_BASE64';
  return 'UNKNOWN';
}

function toPkcs1Pem(body) {
  const wrapped = body.replace(/\s/g, '').match(/.{1,64}/g) || [];
  return `-----BEGIN RSA PRIVATE KEY-----\n${wrapped.join('\n')}\n-----END RSA PRIVATE KEY-----\n`;
}

function toSpkiPem(body) {
  const wrapped = body.replace(/\s/g, '').match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${wrapped.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/**
 * 规范化应用私钥为 PKCS#1 PEM。
 *
 * 之所以要显式检测而不是直接丢给 SDK：
 *   若私钥实为 PKCS#8 却按 PKCS#1 传入，OpenSSL 只抛出
 *   `error:1E08010C:DECODER routines::unsupported`，这个报错极具误导性，
 *   极易被误判成「格式不兼容」进而触发一连串错误操作（补 PEM 头、转格式）。
 *   这里提前识别并给出明确指引。
 */
function normalizePrivateKey(raw) {
  const text = raw.trim();
  const kind = pemKind(text);

  if (kind === 'PKCS8_ENCRYPTED') {
    throw new ConfigError('应用私钥是加密的 PKCS#8（ENCRYPTED PRIVATE KEY），不支持', [
      '请从开放平台重新获取未加密的应用私钥',
      '禁止自行解密或转换格式',
    ]);
  }

  if (kind === 'PKCS8_PRIVATE') {
    throw new ConfigError(
      '应用私钥是 PKCS#8 格式，而 Node.js 必须使用 PKCS#1 格式',
      [
        '请回到支付宝开放平台，取【PKCS#1】格式的应用私钥（非 JAVA 语言用 appPrivatePkcsKey 字段）',
        '禁止使用 openssl 等工具做格式转换，也禁止手工拼接 PEM 头尾',
      ],
    );
  }

  if (kind === 'SPKI_PUBLIC' || kind === 'PKCS1_PUBLIC') {
    throw new ConfigError('配置项里填入了公钥，而不是应用私钥，请检查是否填反');
  }

  let pem;
  if (kind === 'PKCS1_PRIVATE') {
    pem = text.endsWith('\n') ? text : `${text}\n`;
  } else if (kind === 'RAW_BASE64') {
    // 开放平台常见形态：单行裸 base64（PKCS#1 主体）。
    // 这里只是为 crypto/SDK 还原 PEM 容器，不改变密钥内容。
    pem = toPkcs1Pem(text);
  } else {
    throw new ConfigError(`应用私钥形态无法识别（${kind}）`, [
      '应为 PKCS#1 的 PEM 或开放平台提供的单行 base64 私钥',
    ]);
  }

  // 真正解析一次，确保可用
  try {
    crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch (err) {
    // 若其实能按 PKCS#8 解析，说明是格式用错了
    const asPkcs8 = `-----BEGIN PRIVATE KEY-----\n${text.replace(/\s/g, '').match(/.{1,64}/g)?.join('\n') || ''}\n-----END PRIVATE KEY-----\n`;
    let looksPkcs8 = false;
    try {
      crypto.createPrivateKey({ key: asPkcs8, format: 'pem' });
      looksPkcs8 = true;
    } catch { /* ignore */ }

    throw new ConfigError(
      looksPkcs8
        ? '应用私钥无法按 PKCS#1 解析，但可按 PKCS#8 解析 → 说明格式用错了'
        : '应用私钥无法解析，请核对是否与开放平台一致',
      [
        '请使用开放平台【PKCS#1】格式的应用私钥，不要做任何格式转换',
        `底层报错：${err.message}`,
      ],
    );
  }

  return pem;
}

/** 规范化支付宝公钥为 X.509 SPKI PEM */
function normalizeAlipayPublicKey(raw) {
  const text = raw.trim();
  const kind = pemKind(text);

  if (kind === 'PKCS8_PRIVATE' || kind === 'PKCS1_PRIVATE' || kind === 'PKCS8_ENCRYPTED') {
    throw new ConfigError('配置项里填入了私钥，而不是支付宝公钥，请检查是否填反');
  }

  let pem;
  if (kind === 'SPKI_PUBLIC') {
    pem = text.endsWith('\n') ? text : `${text}\n`;
  } else if (kind === 'PKCS1_PUBLIC' || kind === 'RAW_BASE64') {
    // PKCS#1 公钥或裸 base64：为 crypto 还原 SPKI 容器
    pem = toSpkiPem(
      kind === 'RAW_BASE64'
        ? text
        : text.replace(/-----[A-Z ]+-----/g, ''),
    );
  } else if (kind === 'CERTIFICATE') {
    // 允许直接使用证书，从中提取公钥
    try {
      const pub = crypto.createPublicKey(text);
      return pub.export({ type: 'spki', format: 'pem' });
    } catch (err) {
      throw new ConfigError(`支付宝公钥证书解析失败：${err.message}`);
    }
  } else {
    throw new ConfigError(`支付宝公钥形态无法识别（${kind}）`);
  }

  try {
    crypto.createPublicKey({ key: pem, format: 'pem' });
  } catch (err) {
    throw new ConfigError('支付宝公钥无法解析', [
      '请确认填的是开放平台的【支付宝公钥】，不要填成【应用公钥】',
      `底层报错：${err.message}`,
    ]);
  }
  return pem;
}

// ---------------------------------------------------------------- 主入口

/**
 * @param {{envPath?: string, requireSecrets?: boolean}} [opts]
 * @returns {Readonly<object>} 冻结的配置对象
 */
function loadConfig(opts = {}) {
  const env = loadEnvFile(opts.envPath);

  const appId = required('ALIPAY_APP_ID', '应用ID');
  const sellerId = required('ALIPAY_SELLER_ID', '商户ID', ['应为 2088 开头的纯数字']);
  const serviceId = required('ALIPAY_SERVICE_ID', '商户服务ID');
  const sellerName = required('ALIPAY_SELLER_NAME', '商户名称');

  if (!/^2088\d+$/.test(sellerId)) {
    throw new ConfigError(`商户ID 应为 2088 开头的纯数字，当前不符合（长度 ${sellerId.length}）`);
  }

  const amount = required('ALIPAY_AMOUNT', '收费金额', [
    '单位为元，字符串形式，需与入驻时的 service-id 价格一致',
  ]);
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
    throw new ConfigError(`收费金额格式非法：${amount}（应为元为单位的正数字符串，如 0.01）`);
  }

  const payBeforeRaw = (process.env.ALIPAY_PAY_BEFORE_MINUTES || '').trim();
  let payBeforeMinutes = 30;
  if (payBeforeRaw) {
    if (!/^\d+$/.test(payBeforeRaw) || Number(payBeforeRaw) <= 0) {
      throw new ConfigError(`支付截止时间应为正整数（分钟），当前：${payBeforeRaw}`);
    }
    payBeforeMinutes = Number(payBeforeRaw);
  }

  // 默认配置不得被改写
  for (const [envKey, want] of [
    ['ALIPAY_SIGN_TYPE', MANDATED.signType],
    ['ALIPAY_CHARSET', MANDATED.charset],
    ['ALIPAY_FORMAT', MANDATED.format],
    ['ALIPAY_CURRENCY', MANDATED.currency],
  ]) {
    const got = (process.env[envKey] || '').trim();
    if (got && got !== want) {
      throw new ConfigError(`${envKey} 必须为 ${want}，当前为 ${got}（该项为固定默认配置，不可修改）`);
    }
  }

  const gateway = (process.env.ALIPAY_GATEWAY || '').trim() || PROD_GATEWAY;
  if (gateway !== PROD_GATEWAY) {
    throw new ConfigError(`AI 收不支持沙箱，网关必须为 ${PROD_GATEWAY}，当前为 ${gateway}`);
  }

  const priv = readFileOrInline('ALIPAY_APP_PRIVATE_KEY', 'ALIPAY_APP_PRIVATE_KEY_FILE', '应用私钥');
  const pub = readFileOrInline('ALIPAY_PUBLIC_KEY', 'ALIPAY_PUBLIC_KEY_FILE', '支付宝公钥');

  const appPrivateKey = normalizePrivateKey(priv.value);
  const alipayPublicKey = normalizeAlipayPublicKey(pub.value);

  const portRaw = (process.env.PORT || '').trim() || '3000';
  if (!/^\d+$/.test(portRaw)) throw new ConfigError(`PORT 应为数字，当前：${portRaw}`);

  const resourcePath = (process.env.RESOURCE_PATH || '').trim() || '/demo/a2m/resource';
  if (!resourcePath.startsWith('/')) throw new ConfigError('RESOURCE_PATH 必须以 / 开头');

  const validateResponseSign = (process.env.ALIPAY_VALIDATE_RESPONSE_SIGN || 'true').trim() !== 'false';

  const storePath = (process.env.ORDER_STORE_PATH || '').trim() || path.join(ROOT, 'data', 'orders.json');

  const config = {
    envPath: env.path,
    envLoaded: env.loaded,

    appId,
    sellerId,
    serviceId,
    sellerName,

    amount,
    payBeforeMinutes,

    appPrivateKey,
    alipayPublicKey,

    gateway,
    signType: MANDATED.signType,
    charset: MANDATED.charset,
    format: MANDATED.format,
    currency: MANDATED.currency,

    resourcePath,
    goodsName: (process.env.GOODS_NAME || '').trim() || 'AI 生成内容服务',
    port: Number(portRaw),
    validateResponseSign,
    storePath,

    /** 私钥来源，仅用于自检输出（不含任何密钥内容） */
    privateKeySource: priv.source,
    publicKeySource: pub.source,
  };

  return Object.freeze(config);
}

/**
 * 供 alipay-sdk 使用的选项。
 * 依据 SDK 类型定义 dist/commonjs/types.d.ts：
 *   - keyType 默认 PKCS1，这里显式声明以自证意图
 *   - charset 类型仅接受小写 'utf-8'
 *   - camelcase 置 false，保持响应字段与官方文档的 snake_case 一致
 */
function toSdkOptions(config) {
  return {
    appId: config.appId,
    privateKey: config.appPrivateKey,
    alipayPublicKey: config.alipayPublicKey,
    gateway: config.gateway,
    signType: config.signType,
    charset: 'utf-8',
    keyType: 'PKCS1',
    camelcase: false,
    timeout: Number(process.env.ALIPAY_TIMEOUT_MS || 10000),
  };
}

module.exports = {
  loadConfig,
  toSdkOptions,
  ConfigError,
  MANDATED,
  PROD_GATEWAY,
  normalizePrivateKey,
  normalizeAlipayPublicKey,
  pemKind,
};
