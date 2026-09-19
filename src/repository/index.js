'use strict';

/**
 * 订单仓储工厂
 *
 * 业务代码只依赖契约（见 contract.js），不关心背后是文件还是数据库。
 * 切换方式：ORDER_STORE_DRIVER=json | mysql | postgres
 */

const { JsonFileOrderRepository } = require('./jsonFile');
const { SqlOrderRepository } = require('./sql');
const { STATUS, DEFAULT_CONFIRM_LEASE_MS } = require('./contract');

/**
 * @param {object} config loadConfig() 的返回值
 * @returns {JsonFileOrderRepository|SqlOrderRepository}
 */
function createOrderRepository(config) {
  const driver = config.storeDriver;

  if (driver === 'mysql' || driver === 'postgres') {
    return new SqlOrderRepository({
      dialect: driver,
      connection: config.db,
      table: config.dbTable,
      confirmLeaseMs: config.confirmLeaseMs,
    });
  }

  return new JsonFileOrderRepository({ filePath: config.storePath });
}

module.exports = {
  createOrderRepository,
  JsonFileOrderRepository,
  SqlOrderRepository,
  STATUS,
  DEFAULT_CONFIRM_LEASE_MS,
};
