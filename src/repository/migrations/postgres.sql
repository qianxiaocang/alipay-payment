-- AI 收订单表（postgres）
-- 由 src/repository/sql.js 的 SCHEMA 生成，请勿手工修改；改动请改 SCHEMA 后重新生成。

CREATE TABLE IF NOT EXISTS aipay_orders (
       out_trade_no   VARCHAR(64)   PRIMARY KEY,
       resource_id    VARCHAR(512)  NOT NULL,
       amount         VARCHAR(32)   NOT NULL,
       currency       VARCHAR(8)    NOT NULL DEFAULT 'CNY',
       goods_name     VARCHAR(256)  NOT NULL,
       pay_before     VARCHAR(64)   NOT NULL,
       status         VARCHAR(24)   NOT NULL,
       trade_no       VARCHAR(64)   NULL,
       service_result TEXT          NULL,
       payload_fingerprint  CHAR(64) NULL,
       generate_lease_until TIMESTAMPTZ NULL,
       confirm_lease_until TIMESTAMPTZ NULL,
       confirm_attempts    INTEGER NOT NULL DEFAULT 0,
       fulfillment_confirm_ok       BOOLEAN      NULL,
       fulfillment_confirm_code     VARCHAR(64)  NULL,
       fulfillment_confirm_sub_code VARCHAR(64)  NULL,
       fulfillment_confirm_sub_msg  VARCHAR(512) NULL,
       fulfillment_confirm_attempts INTEGER NULL,
       created_at     TIMESTAMPTZ NOT NULL,
       paid_at        TIMESTAMPTZ NULL,
       fulfilled_at   TIMESTAMPTZ NULL
     );

CREATE INDEX IF NOT EXISTS idx_aipay_status ON aipay_orders (status);

CREATE INDEX IF NOT EXISTS idx_aipay_confirm_lease ON aipay_orders (confirm_lease_until);
