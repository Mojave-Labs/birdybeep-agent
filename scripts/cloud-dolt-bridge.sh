#!/usr/bin/env bash
# Cloud-session bridge to the shared beads Dolt server.
#
# In Claude Code CLOUD sessions, raw TCP egress is impossible — bd reaches the
# Dolt server through a Cloudflare-Access-gated tunnel instead. This script
# starts that bridge (cloudflared access tcp) on 127.0.0.1:3307.
#
# It NO-OPS unless TUNNEL_SERVICE_TOKEN_ID/SECRET are present, so it is safe to
# run everywhere (local machines reach the server directly over the tailnet).
#
# Cloud environment config must set:
#   TUNNEL_SERVICE_TOKEN_ID / TUNNEL_SERVICE_TOKEN_SECRET  (Cloudflare Access service token)
#   BEADS_DOLT_SERVER_HOST=127.0.0.1                        (route bd through the bridge)
#   BEADS_DOLT_SERVER_PORT=3307
#   BEADS_DOLT_PASSWORD=<beads db password>
#   DOLT_TUNNEL_HOSTNAME=<tunnel hostname>                  (optional override)
set -u
[ -n "${TUNNEL_SERVICE_TOKEN_ID:-}" ] && [ -n "${TUNNEL_SERVICE_TOKEN_SECRET:-}" ] || exit 0
HOST="${DOLT_TUNNEL_HOSTNAME:-dolt.becs.sh}"
PORT="${BEADS_DOLT_SERVER_PORT:-3307}"

# already bridged?
if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$PORT" 2>/dev/null; then exit 0; fi

# ensure cloudflared (pinned: 2026.7.2 verified working with service tokens; 2026.6.0 is broken)
CF="$(command -v cloudflared || true)"
if [ -z "$CF" ]; then
  ARCH="$(uname -m)"; case "$ARCH" in x86_64) A=amd64;; aarch64|arm64) A=arm64;; *) exit 0;; esac
  curl -fsSL -o /tmp/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/download/2026.7.2/cloudflared-linux-$A" \
    && chmod +x /tmp/cloudflared && CF=/tmp/cloudflared || exit 0
fi

nohup "$CF" access tcp --hostname "$HOST" --url "127.0.0.1:$PORT" </dev/null >/tmp/dolt-bridge.log 2>&1 &
for _ in $(seq 1 20); do
  nc -z 127.0.0.1 "$PORT" 2>/dev/null && break
  sleep 0.5
done
# bd resolves the server port from this untracked file (or BEADS_DOLT_SERVER_PORT)
[ -d .beads ] && echo "$PORT" > .beads/dolt-server.port
exit 0
