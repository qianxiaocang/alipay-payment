'use strict';

/**
 * HTTP 服务
 *
 * 仅暴露两个端点：
 *   GET  <RESOURCE_PATH>   付费资源接口（402 → 校验 → 履约 → 200）
 *   GET  /healthz          健康检查
 *
 * 安全约定：
 *   - 绝不记录私钥、公钥、client_session、payment_proof
 *   - 只记录订单号与结果码，便于对账排查
 */

const express = require('express');
const { handleResourceRequest } = require('./paymentFlow');
const { fromExpressRequest } = require('./requestContext');
const { buildDemoBusinessResponse } = require('./demoBusiness');

/** 敏感字段掩码：任何进入日志的对象都先过一遍 */
const SENSITIVE_KEYS = /private|secret|public_key|publickey|payment_proof|client_session|signature/i;

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

/** 极简结构化日志（零依赖）。生产可替换为 pino/winston */
function createLogger(stream = console) {
  const ts = () => new Date().toISOString();
  return {
    info: (msg, ...args) => stream.log(`${ts()} INFO  ${msg}`, ...args),
    warn: (msg, ...args) => stream.warn(`${ts()} WARN  ${msg}`, ...args),
    error: (msg, ...args) => stream.error(`${ts()} ERROR ${msg}`, ...args),
    redact,
  };
}

/**
 * 构建 express 应用
 *
 * @param {object} args
 * @param {object} args.config
 * @param {import('alipay-sdk').AlipaySdk} args.sdk
 * @param {import('./repository').JsonFileOrderRepository|import('./repository').SqlOrderRepository} args.repository
 * @param {object} [args.logger]
 * @param {(ctx:object)=>string} [args.generateResource]
 */
function createApp({ config, sdk, repository, logger = createLogger(), generateResource }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/healthz', async (req, res) => {
    res.json({ status: 'ok', orders: await repository.size() });
  });

  // 统一按原始字节收取请求体：
  //   - 指纹计算需要「内容本身」，不能是已被解析/重排的对象
  //   - 「API 按次付费」要把买家的 body 原样转发给业务 API
  const captureRawBody = express.raw({ type: () => true, limit: config.maxBodyBytes });

  const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

  app.all(config.resourcePath, captureRawBody, async (req, res) => {
    const started = Date.now();

    if (!ALLOWED_METHODS.includes(req.method)) {
      res.set('Allow', ALLOWED_METHODS.join(', '));
      res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法' });
      return;
    }

    try {
      const result = await handleResourceRequest({
        paymentProofHeader: req.get('Payment-Proof'),
        config,
        sdk,
        repository,
        resourceId: config.resourcePath,
        requestContext: fromExpressRequest(req),
        generateResource,
        logger,
      });

      for (const [k, v] of Object.entries(result.headers || {})) {
        res.set(k, v);
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      logger.error('[aipay] 未捕获异常: %s', err.message);
      res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务内部错误' });
    } finally {
      logger.info(
        '[aipay] %s %s -> %s (%dms)',
        req.method,
        req.path,
        res.statusCode,
        Date.now() - started,
      );
    }
  });

  // ---------------------------------------------------------------- 示例业务接口
  //
  // 用途：让 BUSINESS_API_URL 可以指向本服务的 <BUSINESS_API_LOCAL_PATH>（默认 /action），
  //       从而在没有独立业务服务时也能把 402 链路端到端跑通。
  //
  // ⚠️ 这是【占位实现】：返回固定的 ok + 由幂等键推导的 pick_token，不做任何真实业务。
  //    上线前必须替换为真实业务接口，或设 MOUNT_DEMO_BUSINESS=false 关闭本路由。
  //    它不参与支付校验，也不经过 402 流程 —— 它只是「付费后要被调用的那个接口」。
  if (config.mountDemoBusiness) {
    const captureBusinessBody = express.raw({ type: () => true, limit: config.maxBodyBytes });

    app.all(config.businessApiLocalPath, captureBusinessBody, (req, res) => {
      const raw = Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : (req.body === undefined || req.body === null ? '' : String(req.body));

      const payload = buildDemoBusinessResponse({
        body: raw,
        query: req.query || {},
        idempotencyKey: req.get('Idempotency-Key') || null,
        method: req.method,
        servedBy: 'src/server.js 本地占位业务接口（上线前请替换）',
      });

      logger.info(
        '[business-demo] %s %s | 幂等键=%s | body=%d 字节',
        req.method,
        req.path,
        req.get('Idempotency-Key') || '(无)',
        Buffer.byteLength(raw),
      );

      res.status(200).json(payload);
    });
  }

  // 兜底 404
  app.use((req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: '接口不存在' });
  });

  return app;
}

module.exports = { createApp, createLogger, redact };
