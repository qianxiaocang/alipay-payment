'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig, toSdkOptions, ConfigError, normalizePrivateKey } = require('../src/config');
const { makeTestKeys } = require('./helpers');

const ENV_KEYS = [
  'ALIPAY_APP_ID',
  'ALIPAY_SELLER_ID',
  'ALIPAY_SERVICE_ID',
  'ALIPAY_SELLER_NAME',
  'ALIPAY_AMOUNT',
  'ALIPAY_PAY_BEFORE_MINUTES',
  'ALIPAY_APP_PRIVATE_KEY',
  'ALIPAY_APP_PRIVATE_KEY_FILE',
  'ALIPAY_PUBLIC_KEY',
  'ALIPAY_PUBLIC_KEY_FILE',
  'ALIPAY_SIGN_TYPE',
  'ALIPAY_CHARSET',
  'ALIPAY_FORMAT',
  'ALIPAY_CURRENCY',
  'ALIPAY_GATEWAY',
  'PORT',
  'RESOURCE_PATH',
  'GOODS_NAME',
  'ORDER_STORE_PATH',
  'ALIPAY_VALIDATE_RESPONSE_SIGN',
];

/** 在受控环境变量下执行，结束后完整还原 */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  // 确保不读取磁盘上的真实 .env
  const envPath = path.join(os.tmpdir(), `no-such-env-${Date.now()}`);
  try {
    return fn(envPath);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function baseEnv(overrides = {}) {
  const { privateKey, publicKey } = makeTestKeys();
  return {
    ALIPAY_APP_ID: '2026000000000001',
    ALIPAY_SELLER_ID: '2088123456789012',
    ALIPAY_SERVICE_ID: 'service_x',
    ALIPAY_SELLER_NAME: '某某科技',
    ALIPAY_AMOUNT: '0.01',
    ALIPAY_PAY_BEFORE_MINUTES: '30',
    ALIPAY_APP_PRIVATE_KEY: privateKey,
    ALIPAY_PUBLIC_KEY: publicKey,
    ...overrides,
  };
}

// ================================================================ 正常路径

test('合法配置可加载，且默认项被强制固定', () => {
  withEnv(baseEnv({ ALIPAY_CHARSET: 'UTF-8', ALIPAY_SIGN_TYPE: 'RSA2', ALIPAY_FORMAT: 'json', ALIPAY_CURRENCY: 'CNY' }), (envPath) => {
    const config = loadConfig({ envPath });
    assert.equal(config.signType, 'RSA2');
    assert.equal(config.charset, 'UTF-8');
    assert.equal(config.format, 'json');
    assert.equal(config.currency, 'CNY');
    assert.equal(config.gateway, 'https://openapi.alipay.com/gateway.do');
    assert.equal(config.resourcePath, '/demo/a2m/resource');
    assert.equal(config.payBeforeMinutes, 30);
  });
});

test('pay_before_minutes 缺省时默认 30', () => {
  const env = baseEnv();
  delete env.ALIPAY_PAY_BEFORE_MINUTES;
  withEnv(env, (envPath) => {
    assert.equal(loadConfig({ envPath }).payBeforeMinutes, 30);
  });
});

test('toSdkOptions 传参符合 alipay-sdk 类型定义', () => {
  withEnv(baseEnv(), (envPath) => {
    const opts = toSdkOptions(loadConfig({ envPath }));
    assert.equal(opts.keyType, 'PKCS1', '非 JAVA 语言必须 PKCS1');
    assert.equal(opts.charset, 'utf-8', 'SDK 的 charset 类型只接受小写 utf-8');
    assert.equal(opts.camelcase, false, '关闭驼峰转换以对齐文档 snake_case');
    assert.equal(opts.signType, 'RSA2');
    assert.ok(opts.privateKey.includes('BEGIN RSA PRIVATE KEY'), '私钥应为 PKCS#1 PEM');
  });
});

// ================================================================ 必填项

for (const [key, label] of [
  ['ALIPAY_APP_ID', '应用ID'],
  ['ALIPAY_SELLER_ID', '商户ID'],
  ['ALIPAY_SERVICE_ID', '商户服务ID'],
  ['ALIPAY_SELLER_NAME', '商户名称'],
  ['ALIPAY_AMOUNT', '收费金额'],
]) {
  test(`缺少 ${label}（${key}）→ 拒绝`, () => {
    const env = baseEnv();
    delete env[key];
    withEnv(env, (envPath) => {
      assert.throws(() => loadConfig({ envPath }), (e) => e instanceof ConfigError && e.message.includes(key));
    });
  });
}

test('缺少应用私钥 → 拒绝', () => {
  const env = baseEnv();
  delete env.ALIPAY_APP_PRIVATE_KEY;
  withEnv(env, (envPath) => {
    assert.throws(() => loadConfig({ envPath }), /应用私钥/);
  });
});

test('缺少支付宝公钥 → 拒绝', () => {
  const env = baseEnv();
  delete env.ALIPAY_PUBLIC_KEY;
  withEnv(env, (envPath) => {
    assert.throws(() => loadConfig({ envPath }), /支付宝公钥/);
  });
});

// ================================================================ 私钥格式

test('PKCS#8 私钥 → 明确拒绝并给出可执行指引', () => {
  const { privateKey } = makeTestKeys();
  const pkcs8 = crypto.createPrivateKey(privateKey).export({ type: 'pkcs8', format: 'pem' }).toString();

  withEnv(baseEnv({ ALIPAY_APP_PRIVATE_KEY: pkcs8 }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /PKCS#8/);
      // 必须指引到正确字段，且明确禁止自行转换
      assert.ok(e.hints.some((h) => /appPrivatePkcsKey/.test(h)), 'hints 应指向 appPrivatePkcsKey');
      assert.ok(e.hints.some((h) => /禁止.*转换/.test(h)), 'hints 应禁止格式转换');
      return true;
    });
  });
});

test('裸 base64（PKCS#1 主体）私钥 → 接受并规范化', () => {
  const { privateKey } = makeTestKeys();
  const raw = privateKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');

  withEnv(baseEnv({ ALIPAY_APP_PRIVATE_KEY: raw }), (envPath) => {
    const config = loadConfig({ envPath });
    assert.ok(config.appPrivateKey.includes('BEGIN RSA PRIVATE KEY'));
    // 规范化后必须仍可解析
    assert.doesNotThrow(() => crypto.createPrivateKey(config.appPrivateKey));
  });
});

test('私钥写成单行 \\n 转义 PEM → 接受', () => {
  const { privateKey } = makeTestKeys();
  const oneLine = privateKey.trim().replace(/\n/g, '\\n');

  withEnv(baseEnv({ ALIPAY_APP_PRIVATE_KEY: oneLine }), (envPath) => {
    const config = loadConfig({ envPath });
    assert.ok(config.appPrivateKey.includes('\n'), '应还原为多行 PEM');
    assert.doesNotThrow(() => crypto.createPrivateKey(config.appPrivateKey));
  });
});

test('私钥/公钥填反 → 明确报错', () => {
  const { privateKey, publicKey } = makeTestKeys();

  withEnv(baseEnv({ ALIPAY_APP_PRIVATE_KEY: publicKey }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), /填入了公钥/);
  });

  withEnv(baseEnv({ ALIPAY_PUBLIC_KEY: privateKey }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), /填入了私钥/);
  });
});

test('加密的 PKCS#8 私钥 → 拒绝', () => {
  const { privateKey } = makeTestKeys();
  const encrypted = crypto
    .createPrivateKey(privateKey)
    .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' })
    .toString();

  withEnv(baseEnv({ ALIPAY_APP_PRIVATE_KEY: encrypted }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), /加密/);
  });
});

test('私钥文件方式（_FILE）可读取', () => {
  const { privateKey, publicKey } = makeTestKeys();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipay-key-'));
  const privFile = path.join(dir, 'app.pem');
  const pubFile = path.join(dir, 'alipay.pem');
  fs.writeFileSync(privFile, privateKey);
  fs.writeFileSync(pubFile, publicKey);

  const env = baseEnv({ ALIPAY_APP_PRIVATE_KEY_FILE: privFile, ALIPAY_PUBLIC_KEY_FILE: pubFile });
  delete env.ALIPAY_APP_PRIVATE_KEY;
  delete env.ALIPAY_PUBLIC_KEY;

  withEnv(env, (envPath) => {
    const config = loadConfig({ envPath });
    assert.equal(config.privateKeySource, 'ALIPAY_APP_PRIVATE_KEY_FILE');
    assert.equal(config.publicKeySource, 'ALIPAY_PUBLIC_KEY_FILE');
  });
});

test('私钥文件不存在 → 明确报错', () => {
  const { publicKey } = makeTestKeys();
  const env = baseEnv({ ALIPAY_APP_PRIVATE_KEY_FILE: '/no/such/key.pem', ALIPAY_PUBLIC_KEY: publicKey });
  delete env.ALIPAY_APP_PRIVATE_KEY;

  withEnv(env, (envPath) => {
    assert.throws(() => loadConfig({ envPath }), /文件不存在/);
  });
});

test('normalizePrivateKey 直接调用：PKCS#8 被拒', () => {
  const { privateKey } = makeTestKeys();
  const pkcs8 = crypto.createPrivateKey(privateKey).export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => normalizePrivateKey(pkcs8), /PKCS#8/);
});

// ================================================================ 取值校验

test('商户ID 非 2088 开头 → 拒绝', () => {
  withEnv(baseEnv({ ALIPAY_SELLER_ID: '1234567890' }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), /2088/);
  });
});

test('金额格式非法 → 拒绝', () => {
  for (const bad of ['abc', '-1', '0', '1.234', '']) {
    withEnv(baseEnv({ ALIPAY_AMOUNT: bad }), (envPath) => {
      assert.throws(() => loadConfig({ envPath }), /收费金额/, `金额 ${bad} 应被拒绝`);
    });
  }
});

test('支付截止时间非正整数 → 拒绝', () => {
  for (const bad of ['0', '-5', 'abc', '1.5']) {
    withEnv(baseEnv({ ALIPAY_PAY_BEFORE_MINUTES: bad }), (envPath) => {
      assert.throws(() => loadConfig({ envPath }), /支付截止时间/, `值 ${bad} 应被拒绝`);
    });
  }
});

test('改写默认配置（charset 等）→ 拒绝', () => {
  withEnv(baseEnv({ ALIPAY_CHARSET: 'GBK' }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), /ALIPAY_CHARSET/);
  });
  withEnv(baseEnv({ ALIPAY_SIGN_TYPE: 'RSA' }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), /ALIPAY_SIGN_TYPE/);
  });
  withEnv(baseEnv({ ALIPAY_CURRENCY: 'USD' }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), /ALIPAY_CURRENCY/);
  });
});

test('网关改为沙箱 → 拒绝（本实现按生产语义严格实现）', () => {
  withEnv(baseEnv({ ALIPAY_GATEWAY: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /仅支持生产网关/);
      // 报错必须指引到沙箱流程，而不是让用户自己猜
      assert.ok(e.hints.some((h) => /沙箱/.test(h)), 'hints 应指引到沙箱流程');
      return true;
    });
  });
});

test('RESOURCE_PATH 必须以 / 开头', () => {
  withEnv(baseEnv({ RESOURCE_PATH: 'demo/resource' }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), /RESOURCE_PATH/);
  });
});

test('返回的配置对象被冻结', () => {
  withEnv(baseEnv(), (envPath) => {
    const config = loadConfig({ envPath });
    assert.ok(Object.isFrozen(config));
  });
});

// ================================================================ 清单缺口回归

test('响应验签不可关闭：设置 ALIPAY_VALIDATE_RESPONSE_SIGN=false 也无效', () => {
  // 清单第一节「支付校验无旁路」：生产源码中不得存在可触达的跳过验签开关
  withEnv(baseEnv({ ALIPAY_VALIDATE_RESPONSE_SIGN: 'false' }), (envPath) => {
    const config = loadConfig({ envPath });
    assert.equal(config.validateResponseSign, true, '验签必须恒定开启，环境变量不得关闭它');
  });

  // 任意其他写法也不得关掉
  for (const v of ['0', 'no', 'off', 'FALSE']) {
    withEnv(baseEnv({ ALIPAY_VALIDATE_RESPONSE_SIGN: v }), (envPath) => {
      assert.equal(loadConfig({ envPath }).validateResponseSign, true);
    });
  }
});

test('禁止生产使用内存订单存储（:memory:）', () => {
  // 清单第五节「生产实现完整性」：关键控制不得是「内存演示」
  withEnv(baseEnv({ ORDER_STORE_PATH: ':memory:' }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /:memory:/);
      return true;
    });
  });
});

test('serviceId 不得为沙箱占位值 api_mock_service_id', () => {
  // 清单第七节「AI 按量付费 serviceId 替换」
  withEnv(baseEnv({ ALIPAY_SERVICE_ID: 'api_mock_service_id' }), (envPath) => {
    assert.throws(() => loadConfig({ envPath }), (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /api_mock_service_id/);
      assert.ok(e.hints.some((h) => /serviceId/.test(h)), 'hints 应说明替换为真实 serviceId');
      return true;
    });
  });
});

test('正常 serviceId 不受影响', () => {
  withEnv(baseEnv({ ALIPAY_SERVICE_ID: 'service_ai_content_001' }), (envPath) => {
    assert.equal(loadConfig({ envPath }).serviceId, 'service_ai_content_001');
  });
});
