# ==============================================================================
# 支付宝 AI 收服务
#
# 用法：
#   docker build -t alipay-aipay-service .
#   docker run -d --name aipay \
#     --env-file /etc/alipay/.env \
#     -v /etc/alipay/keys:/etc/alipay/keys:ro \
#     -p 3000:3000 \
#     alipay-aipay-service
#
# ⛔ 绝不把 .env 或私钥 COPY 进镜像，一律运行时挂载/注入。
# ==============================================================================

FROM node:20-alpine

# 时区必须显式设置：pay_before 依赖服务器本地时区。
# 不要依赖基础镜像默认值，某些镜像的 Etc/UTC 被改写会导致 +08:00 解析异常。
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/${TZ} /etc/localtime && \
    echo "${TZ}" > /etc/timezone

WORKDIR /app

# 先装依赖，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && \
    npm cache clean --force

# 再拷源码
COPY src ./src
COPY bin ./bin
COPY scripts ./scripts

# 以非 root 运行；订单目录需要可写
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=3000 \
    ORDER_STORE_PATH=/app/data/orders.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用 node 直接作为 PID 1，确保能收到 SIGTERM（bin/serve.js 已处理优雅关闭）
CMD ["node", "bin/serve.js"]
