-- AI 收订单表（mysql）
-- 由 src/repository/sql.js 的 SCHEMA 生成，请勿手工修改；改动请改 SCHEMA 后重新生成。

CREATE TABLE IF NOT EXISTS aipay_orders (
       out_trade_no   VARCHAR(64)   NOT NULL,
       resource_id    VARCHAR(512)  NOT NULL,
       amount         VARCHAR(32)   NOT NULL,
       currency       VARCHAR(8)    NOT NULL DEFAULT 'CNY',
       goods_name     VARCHAR(256)  NOT NULL,
       pay_before     VARCHAR(64)   NOT NULL,
       status         VARCHAR(24)   NOT NULL,
       trade_no       VARCHAR(64)   NULL,
       service_result MEDIUMTEXT    NULL,
       payload_fingerprint  CHAR(64) NULL,
       generate_lease_until DATETIME(3) NULL,
       confirm_lease_until DATETIME(3) NULL,
       confirm_attempts    INT NOT NULL DEFAULT 0,
       fulfillment_confirm_ok       TINYINT(1)   NULL,
       fulfillment_confirm_code     VARCHAR(64)  NULL,
       fulfillment_confirm_sub_code VARCHAR(64)  NULL,
       fulfillment_confirm_sub_msg  VARCHAR(512) NULL,
       fulfillment_confirm_attempts INT NULL,
       created_at     DATETIME(3) NOT NULL,
       paid_at        DATETIME(3) NULL,
       fulfilled_at   DATETIME(3) NULL,
       PRIMARY KEY (out_trade_no),
       KEY idx_aipay_status (status),
       KEY idx_aipay_confirm_lease (confirm_lease_until)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
