# ============================================================
#  SOL SYSTEMS — Dockerfile
#  File: Dockerfile
#
#  Multi-stage build:
#    Stage 1 (builder) — installs all deps, generates Prisma client
#    Stage 2 (runner)  — copies only production artifacts,
#                        drops devDependencies, runs as non-root
#
#  Resulting image: ~280MB
#  Base: node:20-alpine (smallest stable LTS)
# ============================================================

# ────────────────────────────────────────────────────────────
#  STAGE 1 — Builder
#  Install everything, generate Prisma client
# ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Install build dependencies needed for native modules
RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app

# Copy package files first — layer cache means npm install
# only re-runs when package.json changes, not on code changes
COPY package*.json ./
COPY prisma/schema.prisma ./prisma/

# Install ALL dependencies (including dev)
RUN npm ci --ignore-scripts

# Generate Prisma client for the correct platform
RUN npx prisma generate

# Copy all source files
COPY src/ ./src/

# ────────────────────────────────────────────────────────────
#  STAGE 2 — Runner
#  Production-only image, non-root user
# ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Security: run as non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S solsystems -u 1001 -G nodejs

# Install runtime-only system deps
RUN apk add --no-cache openssl tini

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma/ ./prisma/

# Install PRODUCTION dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Copy generated Prisma client from builder
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy application source
COPY --from=builder /app/src ./src

# Create logs directory with correct ownership
RUN mkdir -p /app/logs && chown -R solsystems:nodejs /app/logs

# Switch to non-root user
USER solsystems

# ────────────────────────────────────────────────────────────
#  RUNTIME CONFIG
# ────────────────────────────────────────────────────────────

# API server port
EXPOSE 3001

# Health check — /health is the public route (no auth required)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Use tini as PID 1 — handles SIGTERM correctly and
# reaps zombie processes (important in containers)
ENTRYPOINT ["/sbin/tini", "--"]

# Run Prisma migrations then start the bot
# db push instead of migrate deploy — faster for Neon serverless
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node src/index.js"]