# syntax=docker/dockerfile:1
# Build context is the REPO ROOT: docker build -f apps/web/Dockerfile .

FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo

# Install with a pruned workspace first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@zendori/web..."

COPY packages/core packages/core
COPY apps/web apps/web
RUN pnpm --filter @zendori/core build && pnpm --filter @zendori/web build

FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# Next.js standalone output keeps the monorepo layout (apps/web/server.js)
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "apps/web/server.js"]
