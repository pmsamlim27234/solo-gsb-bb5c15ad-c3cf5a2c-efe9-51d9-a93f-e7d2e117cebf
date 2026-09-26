# ---- 构建阶段：编译 better-sqlite3 原生模块 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 需要 python3 / make / g++ 进行本地编译
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---- 运行阶段 ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# better-sqlite3 运行时依赖 libstdc++，slim 镜像已自带；创建非 root 用户并预置数据目录
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app

COPY --from=build /app/node_modules ./node_modules
COPY --chown=appuser:appuser server ./server
COPY --chown=appuser:appuser public ./public

USER appuser

EXPOSE 3000

# 容器启动即完成数据库初始化（建表），随后启动 Web 服务
CMD ["sh", "-c", "node server/init-db.js && node server/index.js"]
