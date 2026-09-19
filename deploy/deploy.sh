#!/usr/bin/env bash
# Builds the web app, ships the source to the VPS, builds the image there and
# restarts the container. Secrets live only on the server in
# /opt/ghoclipboard/.env (see README "Deployment"); nothing secret is shipped.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@169.58.25.148}"
REMOTE=/opt/ghoclipboard
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building the web app"
(cd "$ROOT/web" && npx ng build)
grep -q "ghoclipboard.ghonameservices.com" "$ROOT"/web/dist/web/browser/main-*.js \
  || { echo "web build does not point at the hosted API"; exit 1; }

echo "==> Shipping sources"
tar -C "$ROOT" -czf /tmp/ghoclipboard-src.tgz \
  Dockerfile .dockerignore server/package.json server/package-lock.json \
  server/tsconfig.json server/src web/dist/web/browser
scp -q /tmp/ghoclipboard-src.tgz "$HOST:/tmp/ghoclipboard-src.tgz"

echo "==> Building and restarting on $HOST"
ssh "$HOST" bash -s <<EOF
set -euo pipefail
mkdir -p $REMOTE/src $REMOTE/data
rm -rf $REMOTE/src/*
tar -C $REMOTE/src -xzf /tmp/ghoclipboard-src.tgz
docker build -q -t ghoclipboard:latest $REMOTE/src
chown -R 1000:1000 $REMOTE/data
docker rm -f ghoclipboard >/dev/null 2>&1 || true
# Loopback only: Docker-published ports bypass ufw; cloudflared reaches it here.
docker run -d --name ghoclipboard --restart unless-stopped \
  --env-file $REMOTE/.env \
  -v $REMOTE/data:/data \
  -p 127.0.0.1:5780:8787 \
  ghoclipboard:latest
sleep 3
curl -fsS http://127.0.0.1:5780/healthz
EOF
echo
echo "==> Live: https://ghoclipboard.ghonameservices.com"
