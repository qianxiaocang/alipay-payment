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

  app.get(config.resourcePath, async (req, res) => {
    const started = Date.now();
    try {
      const result = await handleResourceRequest({
        paymentProofHeader: req.get('Payment-Proof'),
        config,
        sdk,
        repository,
        resourceId: config.resourcePath,
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

  // 兜底 404
  app.use((req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: '接口不存在' });
  });

  return app;
}

module.exports = { createApp, createLogger, redact };
