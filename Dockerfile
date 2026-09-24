# 海龟汤网站 — Docker 镜像
FROM node:22-alpine

WORKDIR /app

# 拷贝应用源码与依赖清单
COPY server.js package.json package-lock.json ./
COPY public ./public

# 安装依赖（mysql2）
RUN npm install --omit=dev --no-audit --no-fund

# 创建上传文件目录
RUN mkdir -p /app/data/uploads

# 声明数据卷（仅存上传的原始 txt 文件；用户与海龟汤数据在 MySQL 中）
VOLUME ["/app/data"]

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# MySQL 连接（通过环境变量注入，见 .env.example）
# DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME

# 健康检查（Render 等平台用）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
