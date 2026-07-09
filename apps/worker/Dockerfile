# syntax=docker/dockerfile:1
# Build context is the REPO ROOT: docker build -f apps/worker/Dockerfile .

FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter "@zendori/worker..."

COPY packages/core packages/core
COPY apps/worker apps/worker
RUN pnpm --filter @zendori/core build && pnpm --filter @zendori/worker build
# Self-contained production bundle (prod deps only, workspace deps copied in)
RUN pnpm --filter @zendori/worker deploy --legacy --prod /out

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /out ./

USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/healthz || exit 1
CMD ["node", "dist/index.js"]
