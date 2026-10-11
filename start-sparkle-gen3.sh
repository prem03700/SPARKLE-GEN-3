#!/bin/sh
set -eu
APP_DIR="/home/prem-macharla/SPARKLE GEN-3"
STATE_DIR="$HOME/.local/state/sparkle-gen3"
TLS_DIR="$HOME/.config/sparkle/gen3-tls"
mkdir -p "$STATE_DIR"
if curl -fsS --cacert "$TLS_DIR/ca.crt" --max-time 1 https://127.0.0.1:4173/api/health >/dev/null 2>&1; then
  exit 0
fi
if [ ! -r "$TLS_DIR/server.crt" ] || [ ! -r "$TLS_DIR/server.key" ] || [ ! -r "$TLS_DIR/ca.crt" ]; then
  echo "SPARKLE GEN-3 TLS files are missing; refusing to start a LAN-accessible HTTP server." >&2
  exit 1
fi
cd "$APP_DIR"
SPARKLE_HOST=0.0.0.0 SPARKLE_PORT=4173 SPARKLE_TLS_CERT="$TLS_DIR/server.crt" SPARKLE_TLS_KEY="$TLS_DIR/server.key" nohup python3 server.py >> "$STATE_DIR/server.log" 2>&1 </dev/null &
