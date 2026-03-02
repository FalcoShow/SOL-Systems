# ============================================================
#  SOL SYSTEMS — Dockerfile
#  Multi-stage build: builder -> runner
#  Base: node:20-alpine
# ============================================================

# ────────────────────────────────────────────────────────────
#  STAGE 1 — Builder
#  Installs all deps + generates Prisma client
# ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app

# Copy package files — cached unless package.json changes
COPY package*.json ./
COPY prisma/schema.prisma ./prisma/

# Install ALL dependencies (including dev)
RUN npm ci --ignore-scripts

# Generate Prisma client for linux/alpine target platform
RUN npx prisma generate

# ────────────────────────────────────────────────────────────
#  STAGE 2 — Runner
#  Production-only, non-root user
# ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Security: non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S solsystems -u 1001 -G nodejs

RUN apk add --no-cache openssl tini

WORKDIR /app

COPY package*.json ./
COPY prisma/ ./prisma/

# Production deps only
RUN npm ci --omit=dev --ignore-scripts

# Copy generated Prisma client from builder (platform-specific binary)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy src DIRECTLY from build context — NOT from builder stage.
# This ensures Railway never serves stale cached src files.
COPY src/ ./src/
COPY start.sh ./

RUN mkdir -p /app/logs && chown -R solsystems:nodejs /app/logs

USER solsystems

# ────────────────────────────────────────────────────────────
#  RUNTIME
# ────────────────────────────────────────────────────────────

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]

# railway.toml startCommand overrides this CMD.
# This fallback is safe — migrate deploy is idempotent.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]
