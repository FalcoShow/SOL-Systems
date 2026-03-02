#!/usr/bin/env bash
# ============================================================
#  SOL SYSTEMS — Manual Deploy Script
#  File: scripts/deploy.sh
#
#  Run this on your server (or locally targeting Railway)
#  to pull the latest code, run migrations, and restart.
#
#  Usage:
#    chmod +x scripts/deploy.sh
#    ./scripts/deploy.sh
#
#  What it does:
#    1. Pulls latest code from git main branch
#    2. Installs/updates production dependencies
#    3. Regenerates Prisma client
#    4. Runs database migrations (safe — never drops data)
#    5. Restarts the process via PM2 (if available) or direct
#    6. Runs a health check to confirm the deploy succeeded
#
#  Prerequisites (for direct server deploy):
#    - Node.js 20+
#    - npm
#    - git
#    - PM2 (optional but recommended): npm install -g pm2
# ============================================================

set -euo pipefail  # Exit on error, unbound var, or pipe failure

# ── Colours for output ───────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Colour

# ── Config ───────────────────────────────────────────────────
APP_NAME="sol-systems"
APP_DIR="${APP_DIR:-$(pwd)}"      # Default to current directory
BRANCH="${BRANCH:-main}"
PORT="${PORT:-3001}"
HEALTH_URL="http://localhost:${PORT}/health"
HEALTH_RETRIES=10
HEALTH_WAIT=3   # seconds between retries

# ────────────────────────────────────────────────────────────

log_info()  { echo -e "${BLUE}[DEPLOY]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[  OK  ]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[ WARN ]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR ]${NC} $1"; }

# ────────────────────────────────────────────────────────────

log_info "Starting deployment of ${APP_NAME}"
log_info "Directory: ${APP_DIR}"
log_info "Branch:    ${BRANCH}"
echo ""

cd "${APP_DIR}"

# ── Step 1: Pull latest code ─────────────────────────────────
log_info "Pulling latest code from origin/${BRANCH}..."
git fetch origin
git checkout "${BRANCH}"
git pull origin "${BRANCH}"
log_ok "Code updated to $(git rev-parse --short HEAD)"

# ── Step 2: Install production dependencies ──────────────────
log_info "Installing production dependencies..."
npm ci --omit=dev --ignore-scripts
log_ok "Dependencies installed"

# ── Step 3: Regenerate Prisma client ─────────────────────────
log_info "Generating Prisma client..."
npx prisma generate
log_ok "Prisma client generated"

# ── Step 4: Run database migrations ──────────────────────────
log_info "Running database migrations..."

if [ -z "${DATABASE_URL:-}" ]; then
  log_warn "DATABASE_URL not set — skipping migrations"
  log_warn "Set DATABASE_URL in environment and re-run if needed"
else
  # db push is safe for production — adds new columns/tables,
  # never drops existing data without --accept-data-loss flag
  npx prisma db push --skip-generate
  log_ok "Database schema up to date"
fi

# ── Step 5: Restart the application ──────────────────────────
log_info "Restarting application..."

if command -v pm2 &> /dev/null; then
  # PM2 available — preferred for production servers
  if pm2 describe "${APP_NAME}" &> /dev/null; then
    pm2 reload "${APP_NAME}" --update-env
    log_ok "Reloaded via PM2 (zero-downtime)"
  else
    pm2 start src/index.js \
      --name "${APP_NAME}" \
      --log "logs/pm2.log" \
      --merge-logs \
      --restart-delay 3000
    pm2 save
    log_ok "Started via PM2"
  fi
else
  log_warn "PM2 not found — for production installs run: npm install -g pm2"
  log_info "Starting directly with node (no process management)..."
  # Kill any existing process on the port
  if lsof -ti:${PORT} &> /dev/null; then
    log_warn "Killing existing process on port ${PORT}..."
    kill -SIGTERM "$(lsof -ti:${PORT})" 2>/dev/null || true
    sleep 2
  fi
  nohup node src/index.js > logs/app.log 2>&1 &
  echo $! > .pid
  log_ok "Started with PID $(cat .pid)"
fi

# ── Step 6: Health check ─────────────────────────────────────
log_info "Waiting for health check at ${HEALTH_URL}..."

for i in $(seq 1 ${HEALTH_RETRIES}); do
  if curl -sf "${HEALTH_URL}" > /dev/null 2>&1; then
    echo ""
    log_ok "Health check passed ✓"
    log_ok "Deployment complete!"
    echo ""

    # Print the health response for confirmation
    echo -e "${BLUE}System status:${NC}"
    curl -s "${HEALTH_URL}" | \
      node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); \
               const j=JSON.parse(d); \
               console.log('  Status:   ' + j.status); \
               console.log('  Database: ' + (j.db ? 'connected' : 'DISCONNECTED')); \
               console.log('  WebSocket:' + (j.websocket ? 'connected' : 'disconnected')); \
               console.log('  Uptime:   ' + Math.round(j.uptime) + 's');" 2>/dev/null || true
    echo ""
    exit 0
  fi

  log_info "Attempt ${i}/${HEALTH_RETRIES} — waiting ${HEALTH_WAIT}s..."
  sleep "${HEALTH_WAIT}"
done

# Health check failed after all retries
echo ""
log_error "Health check failed after ${HEALTH_RETRIES} attempts"
log_error "Check logs: tail -f logs/app.log"

if command -v pm2 &> /dev/null; then
  log_error "PM2 logs: pm2 logs ${APP_NAME} --lines 50"
fi

exit 1