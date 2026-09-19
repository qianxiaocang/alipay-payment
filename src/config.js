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
 *   3. 本实现按生产语义严格实现，网关固定生产网关（不含沙箱分支）。
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

  // 清单第七节「AI 按量付费 serviceId 替换」：生产配置中不得保留 api_mock_service_id。
  // 该值是沙箱联调专用占位，误带到生产会导致验付/履约对不上真实服务。
  if (serviceId === 'api_mock_service_id') {
    throw new ConfigError('serviceId 不得为 api_mock_service_id（沙箱专用占位值）', [
      '请替换为服务市场注册/复用服务后实际返回的真实 serviceId',
    ]);
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
    // 说明：AI 按量付费确实存在沙箱（见 alipay-aipay 技能，沙箱网关为
    // openapi-sandbox.dl.alipaydev.com，serviceId 固定为 api_mock_service_id）。
    // 本实现按生产语义严格实现，未包含沙箱分支，因此在此明确拒绝，
    // 避免误用沙箱配置却按生产规则校验而产生难以排查的差异。
    throw new ConfigError(
      `本实现仅支持生产网关 ${PROD_GATEWAY}，当前为 ${gateway}`,
      ['如需沙箱联调，请使用 alipay-aipay 技能的沙箱流程与对应实现'],
    );
  }

  const priv = readFileOrInline('ALIPAY_APP_PRIVATE_KEY', 'ALIPAY_APP_PRIVATE_KEY_FILE', '应用私钥');
  const pub = readFileOrInline('ALIPAY_PUBLIC_KEY', 'ALIPAY_PUBLIC_KEY_FILE', '支付宝公钥');

  const appPrivateKey = normalizePrivateKey(priv.value);
  const alipayPublicKey = normalizeAlipayPublicKey(pub.value);

  const portRaw = (process.env.PORT || '').trim() || '3000';
  if (!/^\d+$/.test(portRaw)) throw new ConfigError(`PORT 应为数字，当前：${portRaw}`);

  const resourcePath = (process.env.RESOURCE_PATH || '').trim() || '/demo/a2m/resource';
  if (!resourcePath.startsWith('/')) throw new ConfigError('RESOURCE_PATH 必须以 / 开头');

  // 响应验签恒定开启。
  //
  // 这里刻意【不提供】关闭开关。官方《代码开发校验清单》第一节要求
  // 「生产源码中不存在 Mock、测试或沙箱开关可触达的跳过验签、固定成功
  // 或支付校验旁路」——一个可用环境变量关闭的验签开关正是这种旁路。
  // 测试替身不走本函数（测试直接构造 config 对象），因此无需为此留口子。
  const validateResponseSign = true;

  const storePath = (process.env.ORDER_STORE_PATH || '').trim() || path.join(ROOT, 'data', 'orders.json');

  // 禁止生产使用内存存储。
  // 清单第五节要求关键控制不得是「内存演示」；:memory: 会让订单持久化失效，
  // 而 402 协议强依赖「付款前落库、携带凭证回来时能映射回本地订单」。
  // 测试直接构造 JsonFileOrderRepository({filePath:':memory:'})，不经过本函数。
  if (storePath === ':memory:') {
    throw new ConfigError('ORDER_STORE_PATH 不允许为 :memory:（内存存储仅供测试使用）', [
      '生产必须使用持久化存储（JSON 文件或数据库）',
    ]);
  }

  // 订单仓储驱动：json（单实例）| mysql | postgres（多实例）
  const storeDriver = ((process.env.ORDER_STORE_DRIVER || '').trim() || 'json').toLowerCase();
  if (!['json', 'mysql', 'postgres'].includes(storeDriver)) {
    throw new ConfigError(
      `ORDER_STORE_DRIVER 必须为 json / mysql / postgres，当前为 ${storeDriver}`,
    );
  }

  let db = null;
  if (storeDriver !== 'json') {
    const defaultPort = storeDriver === 'mysql' ? '3306' : '5432';
    const host = (process.env.DB_HOST || '').trim();
    const user = (process.env.DB_USER || '').trim();
    const name = (process.env.DB_NAME || '').trim();
    const password = process.env.DB_PASSWORD ?? '';
    if (!host) throw new ConfigError('缺少必填配置 DB_HOST（使用数据库存储时）');
    if (!user) throw new ConfigError('缺少必填配置 DB_USER（使用数据库存储时）');
    if (!name) throw new ConfigError('缺少必填配置 DB_NAME（使用数据库存储时）');
    if (!password) throw new ConfigError('缺少必填配置 DB_PASSWORD（使用数据库存储时）');

    const portRaw = (process.env.DB_PORT || '').trim() || defaultPort;
    if (!/^\d+$/.test(portRaw)) throw new ConfigError(`DB_PORT 应为数字，当前：${portRaw}`);

    const sslEnabled = (process.env.DB_SSL || '').trim().toLowerCase() === 'true';

    db = {
      host,
      port: Number(portRaw),
      user,
      password,
      database: name,
      ...(sslEnabled ? { ssl: { rejectUnauthorized: true } } : {}),
    };
  }

  const leaseRaw = (process.env.CONFIRM_LEASE_MS || '').trim() || '30000';
  if (!/^\d+$/.test(leaseRaw) || Number(leaseRaw) <= 0) {
    throw new ConfigError(`CONFIRM_LEASE_MS 应为正整数（毫秒），当前：${leaseRaw}`);
  }

  // 回执被其他执行者认领时，本请求最多等待多久再决定返回成功还是可重试失败
  const waitRaw = (process.env.CONFIRM_WAIT_MS || '').trim() || '2000';
  if (!/^\d+$/.test(waitRaw)) {
    throw new ConfigError(`CONFIRM_WAIT_MS 应为非负整数（毫秒），当前：${waitRaw}`);
  }

  // 资源生成租约：持有者崩溃后超过此时长可被其它实例接管生成
  const genLeaseRaw = (process.env.GENERATE_LEASE_MS || '').trim() || '60000';
  if (!/^\d+$/.test(genLeaseRaw) || Number(genLeaseRaw) <= 0) {
    throw new ConfigError(`GENERATE_LEASE_MS 应为正整数（毫秒），当前：${genLeaseRaw}`);
  }

  // ---------------------------------------------------------------- 资源 provider

  const resourceProvider = ((process.env.RESOURCE_PROVIDER || '').trim() || 'static').toLowerCase();
  if (!['static', 'api'].includes(resourceProvider)) {
    throw new ConfigError(`RESOURCE_PROVIDER 必须为 static 或 api，当前为 ${resourceProvider}`);
  }

  const businessApiUrl = (process.env.BUSINESS_API_URL || '').trim();
  if (resourceProvider === 'api' && !businessApiUrl) {
    throw new ConfigError('RESOURCE_PROVIDER=api 时必须配置 BUSINESS_API_URL', [
      '该项指向你自己的业务 API，买家付费后会被调用一次',
    ]);
  }
  if (businessApiUrl && !/^https?:\/\//.test(businessApiUrl)) {
    throw new ConfigError(`BUSINESS_API_URL 必须是 http(s) 地址，当前：${businessApiUrl}`);
  }

  const businessApiMethod = ((process.env.BUSINESS_API_METHOD || '').trim() || 'POST').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(businessApiMethod)) {
    throw new ConfigError(`BUSINESS_API_METHOD 不受支持：${businessApiMethod}`);
  }

  const apiTimeoutRaw = (process.env.BUSINESS_API_TIMEOUT_MS || '').trim() || '15000';
  if (!/^\d+$/.test(apiTimeoutRaw) || Number(apiTimeoutRaw) <= 0) {
    throw new ConfigError(`BUSINESS_API_TIMEOUT_MS 应为正整数（毫秒），当前：${apiTimeoutRaw}`);
  }

  // 载荷绑定：把「被收费的那次请求」与「实际执行的请求」绑定，防止低价付款+高价调用
  const bindPayload = (process.env.RESOURCE_BIND_PAYLOAD || 'true').trim().toLowerCase() !== 'false';

  // 请求体大小上限（字节）。按次付费的 API 常见为 JSON 入参，1MB 足够；
  // 调大可放宽，但要注意这也是单次请求的成本上界。
  const maxBodyRaw = (process.env.MAX_BODY_BYTES || '').trim() || '1048576';
  if (!/^\d+$/.test(maxBodyRaw) || Number(maxBodyRaw) <= 0) {
    throw new ConfigError(`MAX_BODY_BYTES 应为正整数（字节），当前：${maxBodyRaw}`);
  }

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
    storeDriver,
    db,
    dbTable: (process.env.DB_TABLE || '').trim() || 'aipay_orders',
    confirmLeaseMs: Number(leaseRaw),
    confirmWaitMs: Number(waitRaw),
    generateLeaseMs: Number(genLeaseRaw),

    resourceProvider,
    businessApiUrl: businessApiUrl || null,
    businessApiMethod,
    businessApiTimeoutMs: Number(apiTimeoutRaw),
    businessApiAuthHeader: (process.env.BUSINESS_API_AUTH_HEADER || '').trim() || null,
    businessApiAuthValue: (process.env.BUSINESS_API_AUTH_VALUE || '').trim() || null,
    businessApiIdempotencyHeader:
      (process.env.BUSINESS_API_IDEMPOTENCY_HEADER || '').trim() || 'Idempotency-Key',
    businessApiPassQuery: (process.env.BUSINESS_API_PASS_QUERY || 'true').trim().toLowerCase() !== 'false',
    // 默认 false：直接把业务 API 原文作为 content。
    // 归因字段（resource_id/trade_no/out_trade_no）恒在外层响应体上，
    // 不依赖这层包裹；而包裹会多套一层 data，容易让消费方「字段明明返回了却找不到」。
    resourceWrapResponse: (process.env.RESOURCE_WRAP_RESPONSE || 'false').trim().toLowerCase() === 'true',
    resourceServiceType: (process.env.RESOURCE_SERVICE_TYPE || '').trim() || 'API_CALL',
    bindPayload,
    maxBodyBytes: Number(maxBodyRaw),

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
