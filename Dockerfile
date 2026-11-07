# 构建产物演示镜像:mock 模式跑通完整 agent loop,不需要任何 API key
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
CMD ["node", "dist/src/cli.js", "--mock"]
