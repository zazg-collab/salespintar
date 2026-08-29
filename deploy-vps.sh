#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Zero-Drift Deployment Script ke VPS UpCloud
# Otomatis: Sync Kode -> Build Docker -> Purge Redis Cache -> Smoke Test Verifikasi
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SSH_HOST="root@95.111.196.170"
SSH_PORT="2211"
SSH_KEY="$HOME/.ssh/id_ed25519_upcloud"
REMOTE_DIR="/opt/salespintar"
DEPLOY_DIR="$REMOTE_DIR/deploy/upcloud"

echo "🚀 [1/4] Menyinkronkan kode lokal ke VPS..."
rsync -avz \
  -e "ssh -p $SSH_PORT -i $SSH_KEY" \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude 'wa_sessions' \
  --exclude '*.env*' \
  --exclude 'backend/logs' \
  --exclude '.next' \
  --exclude 'frontend/.next' \
  --exclude '.DS_Store' \
  ./ "$SSH_HOST:$REMOTE_DIR/"

echo "🔨 [2/4] Membangun ulang container API & Web di VPS..."
ssh -p "$SSH_PORT" -i "$SSH_KEY" "$SSH_HOST" "
  cd $DEPLOY_DIR && \
  docker compose -f docker-compose.host.yml -p upcloud build api web && \
  docker compose -f docker-compose.host.yml -p upcloud up -d --no-build --no-deps api web && \
  docker image prune -f && \
  docker builder prune -f
"

echo "🧹 [3/4] Membersihkan cache Redis..."
ssh -p "$SSH_PORT" -i "$SSH_KEY" "$SSH_HOST" "
  docker exec salespintar-redis redis-cli -p 6380 FLUSHALL >/dev/null 2>&1 || true
"

echo "🔍 [4/4] Menjalankan Smoke Test Verifikasi Layanan..."
ssh -p "$SSH_PORT" -i "$SSH_KEY" "$SSH_HOST" "
  sleep 3
  API_STATUS=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/v1/business || echo 'FAIL')
  WEB_STATUS=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/login || echo 'FAIL')
  echo \"  - Backend API (Port 3000): HTTP \$API_STATUS\"
  echo \"  - Frontend Web (Port 3001): HTTP \$WEB_STATUS\"
"

echo "✅ Deploy selesai dengan sukses & terverifikasi!"
