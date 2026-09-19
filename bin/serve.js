#!/usr/bin/env node
'use strict';

/**
 * 服务启动入口
 *
 * 启动顺序刻意设计为「配置不合法就拒绝启动」：
 *   本服务按生产语义运行，带着错误配置启动等于把资金风险直接暴露到线上。
 */

const { loadConfig, ConfigError } = require('../src/config');
const { createAlipayClient } = require('../src/alipayClient');
const { createOrderRepository } = require('../src/repository');
const { createApp, createLogger } = require('../src/server');

async function main() {
  const logger = createLogger();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error('配置校验未通过，拒绝启动：%s', err.message);
      for (const hint of err.hints || []) {
        logger.error('  → %s', hint);
      }
      logger.error('请执行 `npm run check-config` 查看完整自检结果');
      process.exit(1);
    }
    throw err;
  }

  const sdk = createAlipayClient(config);
  const repository = createOrderRepository(config);
  await repository.init();

  const app = createApp({ config, sdk, repository, logger });

  const server = app.listen(config.port, () => {
    logger.info('AI 收服务已启动');
    logger.info('  资源接口 : http://localhost:%d%s', config.port, config.resourcePath);
    logger.info('  健康检查 : http://localhost:%d/healthz', config.port);
    logger.info('  应用ID   : %s（末尾4位 %s）', maskTail(config.appId), tail(config.appId));
    logger.info('  商户ID   : %s（末尾4位 %s）', maskTail(config.sellerId), tail(config.sellerId));
    logger.info('  服务ID   : %s', config.serviceId);
    logger.info('  金额     : %s %s', config.amount, config.currency);
    logger.info('  截止时间 : %d 分钟', config.payBeforeMinutes);
    logger.info('  私钥来源 : %s', config.privateKeySource);
    logger.info('  网关     : %s', config.gateway);
    logger.info('  订单存储 : %s（%s）', config.storeDriver, config.storeDriver === 'json'
      ? config.storePath
      : `${config.db.host}:${config.db.port}/${config.db.database}`);
    if (config.storeDriver === 'json') {
      logger.warn('  单实例限制：json 存储不支持多实例部署，横向扩容前请切换为 mysql/postgres');
    }
    logger.info('提示：当前为生产配置，以下每笔请求都是真实交易');
  });

  const shutdown = (signal) => {
    logger.info('收到 %s，正在优雅关闭…', signal);
    server.close(async () => {
      try {
        await repository.close();
      } catch (err) {
        logger.warn('关闭订单存储失败：%s', err.message);
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** 脱敏：只保留首尾少量字符 */
function maskTail(v) {
  const s = String(v);
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(0, s.length - 6))}${s.slice(-4)}`;
}
function tail(v) {
  const s = String(v);
  return s.length <= 4 ? s : s.slice(-4);
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
