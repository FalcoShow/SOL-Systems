#!/bin/sh
set -e
echo "[start.sh] Running prisma migrate deploy..."
npx prisma migrate deploy
echo "[start.sh] Starting node..."
exec node src/index.js
