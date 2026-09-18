# 支付宝 AI 收（A2M 智能收）服务端集成

基于 HTTP `402 Payment Required` 的支付宝收款服务端实现，Node.js。

面向 Agent 收款：消费者 Agent 请求付费资源 → 服务返回 402 → Agent 付款 → 携带凭证再次请求 → 校验并履约。

---

## 目录

- [一分钟了解流程](#一分钟了解流程)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [测试](#测试)
- [上线检查清单](#上线检查清单)
- [安全红线](#安全红线)
- [沙箱、以及第一笔真实交易](#沙箱以及第一笔真实交易)
- [本实现中已踩过的坑](#本实现中已踩过的坑)
- [运维](#运维)
- [部署](#部署)
- [生产化建议](#生产化建议)

---

## 一分钟了解流程

```
消费者 Agent                     你的服务                        支付宝
     |                              |                              |
     |-- 请求资源（无凭证）-------->|                              |
     |                              | 构造订单 + 商家签名          |
     |<-- 402 + Payment-Needed -----|                              |
     |                                                             |
     |-- 发起支付 ------------------------------------------------>|
     |<-- payment_proof + client_session -------------------------|
     |                                                             |
     |-- 请求资源（带 Payment-Proof）->|                            |
     |                              |-- 校验凭证（透传 client_session）-->|
     |                              |<-- active=true, trade_no ---------|
     |                              | 订单校验 / 资源校验 / 金额校验    |
     |                              | 幂等占位 → 生成资源              |
     |                              |-- 履约回执 -------------------->|
     |<-- 200 + Payment-Validation --|                              |
```

---

## 快速开始

```bash
npm install

cp .env.example .env
# 编辑 .env 填入入驻后取得的真实配置

npm run check-config   # 上线前自检（必做）
npm start
```

服务启动后：

```bash
# 健康检查
curl http://localhost:3000/healthz

# 首次请求 → 402
curl -i http://localhost:3000/demo/a2m/resource
```

---

## 配置说明

配置全部通过环境变量 / `.env` 提供，见 `.env.example`。

### 必填项

| 变量 | 说明 |
| --- | --- |
| `ALIPAY_APP_ID` | 应用ID |
| `ALIPAY_SELLER_ID` | 商户ID（2088 开头） |
| `ALIPAY_SERVICE_ID` | 商户服务ID |
| `ALIPAY_SELLER_NAME` | 商户名称 |
| `ALIPAY_AMOUNT` | 收费金额（元），须与入驻时的 service-id 对应 |
| `ALIPAY_APP_PRIVATE_KEY` 或 `..._FILE` | 应用私钥，**必须 PKCS#1** |
| `ALIPAY_PUBLIC_KEY` 或 `..._FILE` | 支付宝公钥 |
| `ALIPAY_PAY_BEFORE_MINUTES` | 支付截止时间（分钟），默认 30 |

### 固定默认项（不可修改）

`ALIPAY_SIGN_TYPE=RSA2`、`ALIPAY_CHARSET=UTF-8`、`ALIPAY_FORMAT=json`、`ALIPAY_CURRENCY=CNY`

这四项由协议规定，代码中已强制固定；填了别的值会导致启动失败。

### 私钥格式（最容易出错的地方）

**Node.js 属于非 JAVA 语言，应用私钥必须使用 PKCS#1 格式**
（`-----BEGIN RSA PRIVATE KEY-----`，即开放平台的 `appPrivatePkcsKey` 字段）。

```bash
# 推荐：用文件方式，避免 .env 多行换行问题
ALIPAY_APP_PRIVATE_KEY_FILE=/etc/alipay/app_private_key.pem
ALIPAY_PUBLIC_KEY_FILE=/etc/alipay/alipay_public_key.pem
```

⛔ 禁止用 `openssl` 等工具做格式转换，禁止手工拼接 PEM 头尾。
`src/config.js` 会在启动前识别格式并给出明确报错，不会让你对着 OpenSSL 的
`DECODER routines::unsupported` 猜。

---

## 测试

```bash
npm test
```

全部测试使用**一次性测试密钥**与 **SDK 测试替身**，不联网、不产生真实交易。

覆盖范围：

| 文件 | 覆盖 |
| --- | --- |
| `test/signing.test.js` | 签名串拼接、Base64URL、ISO 8601 时区、RSA2 签名验签 |
| `test/paymentNeeded.test.js` | 402 载荷分层结构、字段完备性、签名可验签性 |
| `test/config.test.js` | 配置校验、PKCS#1/PKCS#8 识别、默认项强制、网关限制 |
| `test/store.test.js` | 订单持久化、原子写入、并发幂等 |
| `test/flow.test.js` | 两个场景全流程 + 各类拒绝分支 + 并发防重放 |
| `test/server.test.js` | HTTP 层、响应头、日志脱敏 |
| `test/gatewayFallback.test.js` | 无签名响应降级、未验签成功拒绝采信 |

> ⚠️ 测试通过只代表**代码逻辑**正确。真实链路必须用最小金额
> 在真实环境验证一次（沙箱流程见[沙箱、以及第一笔真实交易](#沙箱以及第一笔真实交易)）。

---

## 上线检查清单

### 配置

- [ ] `npm run check-config` 全绿通过
- [ ] 应用私钥为 **PKCS#1** 格式，且**未**做任何格式转换
- [ ] 支付宝公钥填的是**支付宝公钥**，不是应用公钥（自检脚本会检测填反）
- [ ] `ALIPAY_AMOUNT` 与入驻时该 `service-id` 的价格一致
- [ ] `ALIPAY_GATEWAY` 为生产网关（本实现仅支持生产网关，不含沙箱分支）
- [ ] 首次真实联调建议先用最小金额（`0.01`），确认无误后再调回真实价格

### 服务器时区 ⚠️

`pay_before`（支付截止时间）由**服务器本地时间 + 本地时区**生成 ISO 8601。
时区配错会让支付截止时间整体偏移。

- [ ] 确认服务器时区符合预期
- [ ] `npm run check-config` 会打印 `pay_before 预览`，人工核对是否等于「当前时间 + 配置分钟数」

```bash
# 建议显式设置，不要依赖镜像默认值
TZ=Asia/Shanghai
```

> 实测发现：某些容器镜像的 `Etc/UTC` 时区数据被改写过，`TZ=UTC` 会被错误解析成
> `+08:00`。上线前请用 `date` 与自检脚本双重确认。

### 密钥与数据安全

- [ ] `.env` 与 `*.pem` 未被 git 跟踪（`git status` 确认）
- [ ] 私钥未写入任何日志、未进入客户端
- [ ] 订单存储文件（`data/`）已纳入备份

### 网络与部署

- [ ] 服务器能出网访问 `openapi.alipay.com:443`
- [ ] 服务以 HTTPS 对外暴露（Agent 请求会携带支付凭证）
- [ ] 已配置进程守护与优雅重启（`SIGTERM` 已处理）

### 业务幂等

- [ ] 替换 `src/resource.js` 为你自己的业务逻辑，并确认**同一订单重复调用无副作用**
- [ ] 订单存储已替换为数据库/Redis（多实例部署时必须，见[生产化建议](#生产化建议)）

---

## 安全红线

以下每一条都可能导致资金损失或安全事故：

1. **私钥禁止存客户端**：构造交易数据并签名必须在服务端完成，私钥严禁保存在客户端。
2. **私钥禁止记日志**：私钥不得出现在任何日志中。
3. **私钥禁止传公共仓库**：不得上传到 GitHub、GitLab 等公共代码仓库。
4. **前台支付结果不可信**：必须以支付宝服务端校验结果为准，不得信任客户端上报。
5. **未确认不重付**：未确认支付结果前，不得要求用户再次付款。
6. **`client_session` 必须原样透传**：由 C 端 Agent 通过支付宝 CLI 生成，
   商家不得修改、缓存或自行构造，否则校验必然失败。
7. **未验签的成功响应拒绝采信**：网关返回无签名的成功响应时，可能是伪造，
   本实现会直接拒绝（见 `src/verify.js` 的 `execGateway`）。

---

## 沙箱、以及第一笔真实交易

> **更正说明**：本仓库早期版本写着「AI 收不支持沙箱」，那来自
> `alipay-payment-integration` 技能。同仓库中的独立技能 `alipay-aipay`（v1.6.8）
> 实际提供了**完整的 AI 按量付费（402）沙箱**（策略规则 `P-A2M-SANDBOX`：
> 沙箱 `serviceId` 固定为 `api_mock_service_id`，SDK 使用沙箱网关）。
> 沙箱网关：`https://openapi-sandbox.dl.alipaydev.com/gateway.do`

### 生产配置是严格的

本项目在生产语义下运行：网关强制生产地址，网关响应缺少 `resource_id` 一律按异常
处理（`RESOURCE_ID_MISSING`）。这是刻意的 —— 生产环境绝不能让字段缺失被当作校验通过。

如果要用 `alipay-aipay` 的沙箱联调，需要按该技能约定额外支持沙箱网关与
`.alipay-sandbox.json`；当前实现未包含这部分。

### 跑通第一笔真实交易（0.01 元）

商家侧就是本服务；买家侧需要一个**会付款的 Agent**，由支付宝官方
`alipay-pay-for-402-service` 技能提供的 `alipay-bot` CLI 承担。

```bash
# ── 商家侧 ─────────────────────────────────────────────
cp .env.example .env      # 填正式配置，ALIPAY_AMOUNT=0.01
npm run check-config      # 必须全绿
npm start                 # 监听 :3000

# ── 买家侧（另开一个终端）────────────────────────────────
# 1) 安装买家 CLI（装前必须校验完整性）
npm view @alipay/agent-payment@1.0.0 dist.integrity
#    期望 sha512-/Ss+hS75CLYcwC8/jOj2kXzqIoJb7oKGrsiwnqly0EWVTxzD7QY5HxmFuj4anQfHVjnoh77qc2vUYiEAj0zfCA==
npm install @alipay/agent-payment@1.0.0 && npx @alipay/agent-payment@1.0.0 install-cli

# 2) 检查钱包状态（未开通时会引导走 alipay-authenticate-wallet）
alipay-bot -- check-wallet

# 3) 取 Payment-Needed 原文（不要解码、不要改写）
curl -s -D - -o /dev/null http://127.0.0.1:3000/demo/a2m/resource \
  | grep -i "^Payment-Needed:" | sed "s/^[Pp]ayment-[Nn]eeded: //" | tr -d "\r\n" \
  > 402_needed_$(date +%s).txt

# 4) 发起支付 → 输出付款链接/二维码，用真实支付宝付 0.01
alipay-bot -- 402-buyer-pay -f '402_needed_<时间戳>.txt'

# 5) 付款完成后：查询状态并携带凭证重试你的资源接口
alipay-bot 402-query-payment-status -t '<tradeNo>' -r 'http://127.0.0.1:3000/demo/a2m/resource'

# 6) 发送履约回执
alipay-bot -- 402-buyer-fulfillment-ack -t '<tradeNo>'
```

**两个关键实务点：**

1. **第一笔真实交易不需要公网 HTTPS 域名。** 第 5 步是买家 CLI **自己**去重试你的
   资源地址，所以商家服务和买家 CLI 跑在同一台机器时，用 `http://127.0.0.1:3000`
   即可。只有付款那一步与支付宝通信。
2. **`ALIPAY_AMOUNT` 必须与入驻时该 `service-id` 对应的价格一致。** 这不是本地
   随便填的数字 —— 如果入驻时登记的是固定价，填 `0.01` 会直接失败。上线前务必
   核对开放平台/服务市场的登记价格。

### 验证顺序建议

1. `npm test` —— 代码逻辑正确（106 个用例，离线、不产生真实交易）
2. `npm run check-config` —— 配置正确（含密钥往返验签、时区核对、泄漏扫描）
3. 用**最小金额**完成一笔真实支付，确认全链路（402 → 付款 → 校验 → 履约 → 回执）
4. 确认无误后再调回真实价格并放开流量

---

## 本实现中已踩过的坑

这些都是在实际对接与实测中确认的问题，已在代码中处理。

### 1. 响应验签会掩盖所有网关错误（已修复）

`alipay-sdk` 的 `checkResponseSign` **无条件**执行验签，即使网关返回的是
`error_response`（无 `sign` 字段）。此时会抛出：

```
TypeError: The "signature" argument must be of type string ...
```

后果：所有网关级错误（`isv.invalid-app-id`、`isv.invalid-signature` 等）都被这个
无意义的 crypto 报错掩盖 —— 而这恰恰是首次接入时最需要看到的报错。

实测对比：

| 配置 | 结果 |
| --- | --- |
| 直接调用 | `{"code":"40002","sub_code":"isv.invalid-app-id","sub_msg":"无效的AppID参数…traceId=…"}` |
| 开启验签 | `TypeError: The "signature" argument must be of type string…` |

`execGateway()` 的处理：捕获该特定 TypeError → 降级重试取回真实错误码 →
**但绝不采信未验签的成功响应**（返回 `code=10000` 时直接拒绝）。

真正的「验签失败」是安全信号，不会触发降级重试。

### 2. SDK 默认会把响应字段转驼峰

`AlipaySdkConfig.camelcase` 默认为 `true`，会把 `sub_code`/`out_trade_no` 转成
`subCode`/`outTradeNo`，与官方文档字段名不一致，极易读错字段。

本实现显式设置 `camelcase: false` 保持 snake_case，同时在 `pick()` 中兼容两种写法。

### 3. SDK 的 charset 只接受小写

`AlipaySdkConfig.charset` 类型仅接受 `'utf-8'`。配置层对外保持协议要求的
`UTF-8`，传给 SDK 时归一化为 `'utf-8'`。

### 4. 请求体不会被自动转驼峰

实测确认（`sdkExec` 输出）：`bizContent` 会**原样**序列化到线上。
因此 `src/verify.js` 中必须使用 snake_case（`payment_proof` / `trade_no` / `client_session`）。

### 5. `pay_before` 用 ISO 8601，不是 `yyyy-MM-dd HH:mm:ss`

传统收单产品的时间戳用 `yyyy-MM-dd HH:mm:ss`；
AI 收的 `pay_before` 用 **ISO 8601 带时区偏移**（如 `2026-04-15T12:54:37+08:00`）。
两者不可混用。

### 6. 官方示例中未实现的三处（本实现已补全）

官方 Node 示例把这三件事写成了 `【TODO】` 注释，但它们直接对应资金风险：

| 项 | 风险 | 本实现 |
| --- | --- | --- |
| 订单查询 | 无法确认凭证对应的订单 | `store.get()`，缺失返回 404 |
| 资源ID防串校验 | 用 A 资源的凭证换取 B 资源 | 比对响应/订单/请求三者；**字段缺失按异常处理**（502），存在但不符返回 403 |
| 履约防重放 | 重复请求导致重复交付 | 两阶段履约 + 每订单互斥，并发下只生成一次资源、只上报一次回执 |

### 7. 可重试的履约回执（已修正）

官方 `alipay-aipay` 参考实现要求：`alipay.aipay.agent.fulfillment.confirm` 失败时
**不得返回成功交付**，且应允许用同一 Payment-Proof 重试上报。

本实现早期版本是「生成资源即置 FULFILLED，回执失败仅记日志并返回 200」——
后果是回执永久丢失，重试还会命中「已履约」分支而永不补发。
现已改为两阶段状态机（见[履约回执补偿](#履约回执补偿)）。

### 8. 老版本会把 `resource_id` 缺失当成校验通过（已修正）

早期判断写成「字段存在才比较」，意味着网关响应里**完全没有** `resource_id` 时
会直接跳过防串校验。官方文档明确要求「生产环境必须把资源字段缺失当作异常处理」。
现已改为硬失败（`RESOURCE_ID_MISSING`，502），空串与仅空白也视为缺失。

---

## 运维

### 履约回执补偿

履约采用**两阶段**设计，因为官方规范要求「回执上报失败不得返回成功交付，
且允许用同一 Payment-Proof 重试上报」：

```
PENDING → 生成资源 → PENDING_CONFIRM → 回执确认成功 → FULFILLED
                          ↑                  |
                          └──── 失败则停留 ───┘
```

- 资源在进入 `PENDING_CONFIRM` 时**只生成一次并落库**，重试复用，不会重复生成
- 回执失败返回 `502 FULFILLMENT_CONFIRM_FAILED`，订单停在 `PENDING_CONFIRM`
- 消费者用**同一份 Payment-Proof 重试**即可补发回执并闭环
- `FULFILLED` 一定意味着回执已上报成功

需要兜底时可加定时任务，捞出长时间停留在 `PENDING_CONFIRM` 的订单主动补发：

```js
const pending = store.listPendingFulfillmentConfirm(); // 停在 PENDING_CONFIRM 的订单
for (const order of pending) {
  const r = await callFulfillmentConfirm({ sdk, tradeNo: order.trade_no, validateSign: true });
  if (r.ok) await store.markFulfilled(order.out_trade_no, order.trade_no);
}
```

### 并发与幂等边界

- **进程内**：同一订单的「履约 + 回执」由 `store.withOrderLock()` 互斥，
  并发携带同一凭证只会生成一次资源、只上报一次回执
- **多实例**：进程内锁失效，必须改用分布式锁，并以数据库唯一约束
  作为幂等的最终保证（见「生产化建议」）

### 接口错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `Payment-Needed` | 402 | 需要支付（首次请求） |
| `INVALID_PAYMENT_PROOF_FORMAT` | 400 | 凭证格式错误 |
| `INVALID_PAYMENT_PROOF` | 400 | 凭证无效或已过期 |
| `ORDER_NOT_FOUND` | 404 | 订单不存在 |
| `RESOURCE_ID_MISMATCH` | 403 | 资源ID存在但与订单/请求不符（疑似资源串改） |
| `RESOURCE_ID_MISSING` | 502 | 网关响应缺少资源标识（按异常处理，拒绝交付） |
| `AMOUNT_MISMATCH` | 400 | 金额不一致 |
| `VERIFY_FAILED` | 500 | 校验调用失败 |
| `FULFILLMENT_ERROR` | 500 | 履约处理失败 |
| `FULFILLMENT_CONFIRM_FAILED` | 502 | 资源已生成但履约回执未确认，可用同一 Payment-Proof 重试 |
| `ALREADY_FULFILLED` | 200 | 已履约，复用已落库资源 |
| `SIGN_ERROR` | 500 | 构造支付请求失败 |
| `CREATE_ORDER_ERROR` | 500 | 创建订单失败 |

---

## 部署

### Docker（推荐）

私钥与配置一律运行时挂载，绝不进镜像：

```bash
docker build -t alipay-aipay-service .

docker run -d --name aipay --restart unless-stopped \
  --env-file /etc/alipay/.env \
  -v /etc/alipay/keys:/etc/alipay/keys:ro \
  -v /var/lib/aipay:/app/data \
  -p 3000:3000 \
  alipay-aipay-service

docker logs -f aipay
```

镜像内已显式设置 `TZ=Asia/Shanghai`（见 [服务器时区](#服务器时区-)）。

### 直接部署

```bash
npm ci --omit=dev
TZ=Asia/Shanghai npm run check-config
TZ=Asia/Shanghai npm start
```

用 systemd / pm2 做进程守护。`bin/serve.js` 已处理 `SIGTERM` 优雅关闭。

### 反向代理

服务应通过 HTTPS 对外暴露（请求会携带支付凭证）。
Nginx 示例：

```nginx
location /demo/a2m/resource {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Payment-Proof / Payment-Needed / Payment-Validation 均为自定义头，
    # 默认即可透传；若使用了会剥离未知头的网关需显式放行
    proxy_pass_request_headers on;
}
```

---

## 生产化建议

当前实现可直接用于生产验证，但以下项建议按需替换：

| 项 | 现状 | 建议 |
| --- | --- | --- |
| 订单存储 | JSON 文件（原子写入 + 串行化） | 多实例部署换 Redis/数据库，并以唯一索引作为幂等的最终保证 |
| 履约互斥 | 进程内 `withOrderLock` | 多实例部署换分布式锁，否则并发重复请求可能重复上报回执 |
| 日志 | 极简 console 封装 | 换 pino/winston，接入日志采集 |
| 限流 | 无 | 资源接口加限流，防止凭证暴力尝试 |
| 监控 | 无 | 对 402 转化率、校验失败率、回执失败率、`PENDING_CONFIRM` 堆积做监控告警 |
| 资源生成 | `src/resource.js` 占位实现 | 替换为真实业务逻辑 |
| 回执补偿 | 提供 `listPendingFulfillmentConfirm()` | 加定时任务补发停留在 `PENDING_CONFIRM` 的订单 |

---

## 相关文档

- [A2M 智能收产品对接文档](https://github.com/alipay/ai)（本仓库实现依据）
- [支付宝开放平台](https://open.alipay.com)
- [商户一站式入驻平台](https://b.alipay.com/page/home/open-ai-pay)
