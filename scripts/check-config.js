#!/usr/bin/env node
'use strict';

/**
 * 上线前配置自检
 *
 * 定位：本服务按生产语义运行，配置错误会直接作用在真实交易上。
 * 本脚本在启动服务之前，把「能提前发现的问题」全部提前发现。
 *
 * 它做四件事：
 *   1. 复用 src/config.js 做完整配置校验（必填项、私钥格式、固定默认项、网关）
 *   2. 做一次真实的签名自测，证明私钥可用（签名→验签往返）
 *   3. 检查敏感信息泄漏防护（.gitignore、源码硬编码）
 *   4. 检查服务器时区 —— pay_before 依赖本地时区，时区错会导致支付截止时间错
 *
 * ⛔ 绝不打印私钥、公钥等敏感值。
 *
 * 用法：npm run check-config
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadConfig, ConfigError } = require('../src/config');
const { signRsa2, verifyRsa2, formatIso8601WithTimezone } = require('../src/signing');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m',
  red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m',
};

const ok = (m) => { pass++; console.log(`  ${C.green}✓${C.reset} ${m}`); };
const bad = (m) => { fail++; failures.push(m); console.log(`  ${C.red}✗${C.reset} ${m}`); };
const warn = (m) => console.log(`  ${C.yellow}!${C.reset} ${m}`);
const info = (m) => console.log(`  ${C.dim}·${C.reset} ${m}`);
const section = (t) => console.log(`\n${C.bold}${t}${C.reset}`);

/** 脱敏：只显示首尾 */
function mask(v, keepStart = 2, keepEnd = 4) {
  const s = String(v);
  if (s.length <= keepStart + keepEnd) return '*'.repeat(s.length);
  return `${s.slice(0, keepStart)}${'*'.repeat(s.length - keepStart - keepEnd)}${s.slice(-keepEnd)}`;
}

/** 递归扫描源码，找硬编码密钥 */
function scanHardcodedSecrets(dir, hits = []) {
  if (!fs.existsSync(dir)) return hits;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      scanHardcodedSecrets(p, hits);
      continue;
    }
    if (!/\.(js|cjs|mjs|json|ts)$/.test(p)) continue;
    if (p.endsWith('check-config.js')) continue;
    if (p.includes(`${path.sep}test${path.sep}`)) continue; // 测试用一次性密钥
    const text = fs.readFileSync(p, 'utf8');
    // 必须匹配【完整的 PEM 块且密钥主体为纯 base64】。
    // 两个关键约束共同避免误报：
    //   1. 主体限定为 [A-Za-z0-9+/=\s]，源码里用模板串拼装的 PEM
    //      （含 ${} 、引号、括号等）不会被误判
    //   2. 主体长度 >= 200，排除仅出现 PEM 头字面量的情况
    // 支付宝要求 RSA 2048，其 base64 主体约 1600 字符，阈值留足余量。
    const fullPemBlock = /-----BEGIN [A-Z ]*PRIVATE KEY-----([A-Za-z0-9+/=\s]{200,}?)-----END [A-Z ]*PRIVATE KEY-----/;
    // 裸 base64 私钥：以 MII 开头且后续有大量 base64 字符
    const rawKeyBody = /MII[A-Za-z0-9+/]{200,}/;
    if (fullPemBlock.test(text) || rawKeyBody.test(text)) {
      hits.push(path.relative(ROOT, p));
    }
  }
  return hits;
}

console.log(`${C.bold}===== AI 收上线前配置自检 =====${C.reset}`);

// ---------------------------------------------------------------- 0. 运行环境

section('[0] 运行环境');

const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) ok(`Node.js ${process.versions.node}`);
else bad(`Node.js 版本过低（${process.versions.node}），需 >= 18`);

const tzOffset = -new Date().getTimezoneOffset();
const tzSign = tzOffset >= 0 ? '+' : '-';
const tzAbs = Math.abs(tzOffset);
info(`服务器本地时间：${formatIso8601WithTimezone(new Date())}`);
info(`时区偏移：${tzSign}${String(Math.floor(tzAbs / 60)).padStart(2, '0')}:${String(tzAbs % 60).padStart(2, '0')}`);

// ---------------------------------------------------------------- 1. 配置校验

section('[1] 配置校验');

let config;
try {
  config = loadConfig();
  ok(`配置文件已载入：${config.envLoaded ? config.envPath : '（未找到 .env，仅使用环境变量）'}`);
} catch (err) {
  if (err instanceof ConfigError) {
    bad(`配置校验失败：${err.message}`);
    for (const h of err.hints || []) warn(`→ ${h}`);
    console.log(`\n${C.red}配置自检未通过，按 SKILL.md 步骤 1.2b 规定暂停，不得启动服务。${C.reset}`);
    process.exit(1);
  }
  throw err;
}

// ---------------------------------------------------------------- 2. 配置摘要

section('[2] 配置摘要（已脱敏）');
info(`应用ID   : ${mask(config.appId)}`);
info(`商户ID   : ${mask(config.sellerId)}`);
info(`服务ID   : ${config.serviceId}`);
info(`商户名称 : ${config.sellerName}`);
info(`金额     : ${config.amount} ${config.currency}`);
info(`截止时间 : ${config.payBeforeMinutes} 分钟`);
info(`资源路径 : ${config.resourcePath}`);
info(`商品名称 : ${config.goodsName}`);
info(`资源来源 : ${config.resourceProvider}${config.resourceProvider === 'api'
  ? `（${config.businessApiMethod} ${config.businessApiUrl}）`
  : '（占位内容，未接入真实业务）'}`);
info(`载荷绑定 : ${config.bindPayload ? '开启' : '关闭'}`);
info(`网关     : ${config.gateway}`);
info(`私钥来源 : ${config.privateKeySource}`);
info(`公钥来源 : ${config.publicKeySource}`);
info(`订单存储 : ${config.storeDriver}${config.storeDriver === 'json'
  ? `（${config.storePath}）`
  : `（${config.db.host}:${config.db.port}/${config.db.database}）`}`);
info('响应验签 : 恒定开启（不提供关闭开关）');

// ---------------------------------------------------------------- 3. 密钥自测

section('[3] 密钥可用性自测');

try {
  const content = `selftest=${Date.now()}`;
  const sig = signRsa2(content, config.appPrivateKey);

  // 从应用私钥导出公钥做往返验签，证明私钥本身可签名
  const derivedPub = crypto.createPublicKey(config.appPrivateKey).export({ type: 'spki', format: 'pem' });
  if (verifyRsa2(content, sig, derivedPub)) ok('应用私钥可正常签名并通过往返验签');
  else bad('应用私钥签名后无法验签，私钥可能损坏');
} catch (err) {
  bad(`应用私钥签名失败：${err.message}`);
}

try {
  crypto.createPublicKey(config.alipayPublicKey);
  ok('支付宝公钥可正常解析');
} catch (err) {
  bad(`支付宝公钥解析失败：${err.message}`);
}

// 用支付宝公钥去验应用私钥的签名，若通过说明私钥/公钥配成了一对（这是错误配置）
try {
  const content = 'crosscheck';
  const sig = signRsa2(content, config.appPrivateKey);
  if (verifyRsa2(content, sig, config.alipayPublicKey)) {
    bad('支付宝公钥能验证应用私钥的签名 → 你把「应用公钥」当成「支付宝公钥」填了');
    warn('→ 请到开放平台复制【支付宝公钥】，而不是应用公钥');
  } else {
    ok('应用私钥与支付宝公钥不是同一对密钥（符合预期）');
  }
} catch { /* 忽略 */ }

// ---------------------------------------------------------------- 4. 泄漏防护

section('[4] 敏感信息泄漏防护');

const gi = path.join(ROOT, '.gitignore');
if (!fs.existsSync(gi)) {
  bad('.gitignore 缺失，私钥有被提交到仓库的风险');
} else {
  const g = fs.readFileSync(gi, 'utf8');
  if (/^\s*\.env\s*$/m.test(g)) ok('.gitignore 已忽略 .env');
  else bad('.gitignore 未忽略 .env');

  if (/^\s*\.env\.\*/m.test(g)) ok('.gitignore 已忽略 .env.*');
  else warn('.gitignore 未忽略 .env.*');

  if (/^\s*\*\.pem/m.test(g) || /^\s*\*\.key/m.test(g)) ok('.gitignore 已忽略密钥文件');
  else warn('.gitignore 未忽略 *.pem / *.key，建议补充');
}

const hits = scanHardcodedSecrets(ROOT);
if (hits.length) {
  bad(`以下文件疑似硬编码密钥：${hits.join(', ')}`);
  warn('→ 必须改为从配置/环境变量读取');
} else {
  ok('未在源码中发现硬编码密钥');
}

// 确认 .env 真的不会被 git 跟踪
try {
  const { execFileSync } = require('child_process');
  const tracked = execFileSync('git', ['ls-files', '--error-unmatch', '.env'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim();
  if (tracked) bad('.env 已被 git 跟踪！请立即执行 git rm --cached .env');
  else ok('.env 未被 git 跟踪');
} catch {
  ok('.env 未被 git 跟踪');
}

// ---------------------------------------------------------------- 5. 业务风险提示

section('[5] 上线风险提示');

// 验签必须恒定开启（清单第一节「支付校验无旁路」）
if (config.validateResponseSign === true) {
  ok('网关响应验签已开启，且不存在可关闭的开关');
} else {
  bad('响应验签未开启 —— 违反「支付校验无旁路」要求');
}

if (config.mountDemoBusiness) {
  warn(`本服务内挂载了占位业务接口 ${config.businessApiLocalPath} —— 上线前必须替换为真实业务或设 MOUNT_DEMO_BUSINESS=false`);
} else {
  ok(`未挂载占位业务接口（业务接口应在 ${config.businessApiUrl || "外部"} ）`);
}

if (config.resourceProvider === 'static') {
  warn('资源来源为 static（占位内容）—— 上线前必须切到 RESOURCE_PROVIDER=api 并配置 BUSINESS_API_URL');
} else {
  ok(`资源来源为业务 API：${config.businessApiMethod} ${config.businessApiUrl}`);
}

if (!config.bindPayload && config.resourceProvider === 'api') {
  bad('载荷绑定已关闭且使用业务 API —— 存在「低价付款、高价调用」风险，必须开启');
} else if (config.bindPayload) {
  ok('已开启载荷绑定（防低价付款、高价调用）');
}

if (config.storeDriver === 'json') {
  ok('订单存储为持久化存储（json）');
  warn('json 驱动使用进程内互斥，**只能单实例部署**；横向扩容前请切换为 mysql/postgres');
} else {
  ok(`订单存储为数据库（${config.storeDriver}），支持多实例`);
}


const amt = Number(config.amount);
if (amt > 1) {
  warn(`收费金额为 ${config.amount} 元。首次真实联调建议先用最小金额（如 0.01）验证，确认无误后再调回`);
} else {
  ok(`收费金额为 ${config.amount} 元，适合首次小额验证`);
}

const tzHours = tzAbs / 60;
if (tzHours === 8) {
  ok('时区偏移 +08:00，符合中国大陆预期');
} else if (tzOffset === 0) {
  warn('时区偏移 +00:00（UTC）。pay_before 会用 UTC 时间生成带 +00:00 的 ISO 8601；');
  warn('→ 若你的服务器应为东八区，请设置 TZ=Asia/Shanghai，否则支付截止时间会偏 8 小时');
} else {
  warn(`时区偏移为 ${tzSign}${String(Math.floor(tzHours)).padStart(2, '0')}:00，请确认这是你的预期时区`);
}

// 预览一个真实的 pay_before 样例，便于人工核对
const preview = new Date(Date.now() + config.payBeforeMinutes * 60 * 1000);
info(`pay_before 预览：${formatIso8601WithTimezone(preview)}（当前时间 + ${config.payBeforeMinutes} 分钟）`);

// ---------------------------------------------------------------- 存储可用性

section('[6] 订单存储可用性');

(async () => {
  const { createOrderRepository } = require('../src/repository');
  let repository = null;

  if (config.storeDriver === 'json') {
    try {
      repository = createOrderRepository(config);
      await repository.init();
      const n = await repository.size();
      ok(`json 存储可读写（当前 ${n} 条订单）：${config.storePath}`);
    } catch (err) {
      bad(`json 存储不可用：${err.message}`);
    } finally {
      if (repository) await repository.close().catch(() => {});
    }
  } else {
    const target = `${config.db.host}:${config.db.port}/${config.db.database}`;
    try {
      repository = createOrderRepository(config);
      await repository.init();
      const n = await repository.size();
      ok(`数据库连通且表结构就绪（当前 ${n} 条订单）：${target}`);
      info(`表名：${config.dbTable}`);
    } catch (err) {
      bad(`数据库不可用：${err.message}`);
      warn('→ 检查 DB_* 配置、网络连通性、账号权限；表不存在时会自动创建');
    } finally {
      if (repository) await repository.close().catch(() => {});
    }
  }

  // ------------------------------------------------------------ 结论

  console.log(`\n${C.bold}===== 自检结论 =====${C.reset}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);

  if (fail > 0) {
    console.log(`\n${C.red}自检未通过，请先修复以下问题再启动服务：${C.reset}`);
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }

  console.log(`\n${C.green}配置自检通过。${C.reset}`);
  console.log(`${C.yellow}⚠️  当前为生产配置：启动后每一笔请求都是真实交易。${C.reset}`);
  console.log('   建议：先阅读 README 的「上线检查清单」，并用最小金额完成首笔真实交易验证。');
})();

