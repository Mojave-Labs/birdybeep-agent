#!/usr/bin/env bash
#
# verdaccio-rehearsal.sh — dress-rehearse the @birdybeep/* npm publish locally.
#
# Spins up a throwaway Verdaccio registry, publishes ALL packages with pnpm
# (never npm — pnpm rewrites `workspace:*` to real versions; npm ships it raw),
# then does a REAL `npm install -g @birdybeep/cli` from that local registry into
# an ISOLATED prefix (your real global npm is left untouched) and runs the binary.
#
# Nothing touches the public npm registry. Run it from anywhere inside the repo:
#
#   chmod +x scripts/verdaccio-rehearsal.sh   # once
#   ./scripts/verdaccio-rehearsal.sh
#
# Override the port if 4873 is busy:  PORT=4874 ./scripts/verdaccio-rehearsal.sh
#
set -euo pipefail

PORT="${PORT:-4873}"
REGISTRY="http://localhost:${PORT}"
WORK="${TMPDIR:-/tmp}/bb-verdaccio"          # everything lives here; wiped each run
STORAGE="$WORK/storage"
CONFIG="$WORK/config.yaml"
NPMRC="$WORK/npmrc"
GLOBAL_PREFIX="$WORK/global"                 # isolated -g prefix
LOG="$WORK/verdaccio.log"

# Resolve the repo root from this script's location (works from anywhere in the tree).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR")"
cd "$REPO_ROOT"

echo "▶ repo:     $REPO_ROOT"
echo "▶ registry: $REGISTRY"
command -v pnpm >/dev/null || { echo "✗ pnpm not found on PATH"; exit 1; }
command -v curl >/dev/null || { echo "✗ curl not found on PATH"; exit 1; }

if curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1; then
  echo "✗ something is already listening on $REGISTRY — stop it (or set PORT=xxxx) and re-run."
  exit 1
fi

# ---- 1. Fresh workspace (wiping storage avoids same-version republish collisions) ----
rm -rf "$WORK"
mkdir -p "$STORAGE" "$GLOBAL_PREFIX"

# ---- 2. Verdaccio config: @birdybeep/* served locally, everything else proxied to npmjs ----
# (the CLI's deps like zod / smol-toml must still resolve, so we proxy the public registry)
cat > "$CONFIG" <<EOF
storage: $STORAGE
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@birdybeep/*':
    access: \$all
    publish: \$anonymous
    unpublish: \$anonymous
  '**':
    access: \$all
    publish: \$anonymous
    proxy: npmjs
log: { type: stdout, level: warn }
EOF

# Isolated npm/pnpm config: points the registry at Verdaccio + a dummy token (Verdaccio
# allows anonymous publish, but the npm client refuses to publish with no token set).
# Kept OUT of your ~/.npmrc, and — crucially — applied ONLY to the publish/install steps
# below via `NPM_CONFIG_USERCONFIG=… <cmd>`, never exported globally. If it were exported,
# the `npx verdaccio` calls would try to fetch verdaccio itself from the (not-yet-running)
# local registry and fail with ECONNREFUSED.
cat > "$NPMRC" <<EOF
registry=$REGISTRY/
@birdybeep:registry=$REGISTRY/
//localhost:$PORT/:_authToken=local-anonymous-token
EOF

# ---- 3. Start Verdaccio (kill it on any exit) ----
# Pre-fetch it in the FOREGROUND first: the first `npx verdaccio` downloads hundreds of
# packages, and npm hides its progress bar when stdout isn't a TTY — so backgrounding it
# straight to a log looks like a silent hang. Fetch synchronously (visible), then start.
echo "▶ ensuring verdaccio is installed (first run downloads it — may take a minute)…"
if ! npx --yes verdaccio@6 --version; then
  echo "✗ couldn't run 'npx verdaccio@6'. Install it once with 'npm i -g verdaccio' (check network/registry), then re-run."
  exit 1
fi

echo "▶ starting verdaccio…"
npx --yes verdaccio@6 --config "$CONFIG" --listen "$PORT" >"$LOG" 2>&1 &
VERDACCIO_PID=$!
trap 'echo "▶ stopping verdaccio (pid $VERDACCIO_PID)"; kill "$VERDACCIO_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 90); do
  curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1 && break
  # Bail early with the log if verdaccio died instead of just being slow to bind.
  kill -0 "$VERDACCIO_PID" 2>/dev/null || break
  sleep 1
done
if ! curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1; then
  echo "✗ verdaccio didn't come up on $REGISTRY. Its log ($LOG):"
  [ -s "$LOG" ] && tail -30 "$LOG" || echo "  (log is empty — is port $PORT taken, or did the process fail to bind? try PORT=4874)"
  exit 1
fi
echo "✓ verdaccio up (log: $LOG)"

# ---- 4. Build + packaging guard BEFORE publishing ----
# `files: ["dist"]` means an unbuilt tree packs near-EMPTY tarballs (just package.json +
# LICENSE) and the CLI's `bin` target doesn't exist. check-pack fails hard if dist/ is
# missing or anything forbidden would ship, so a bad rehearsal can't look like a good one.
echo "▶ building all packages…"
pnpm turbo build
node scripts/check-pack.mjs

# ---- 5. Publish ALL packages with pnpm (resolves workspace:* → real versions) ----
# NPM_CONFIG_USERCONFIG is applied per-command here (not exported) so it can't affect the
# verdaccio downloads above. pnpm honors this env var for its registry + auth token.
# --force: pnpm keeps a CLIENT-side metadata cache per registry host; a version published
# to localhost:${PORT} in an earlier run (even against long-gone storage) makes pnpm
# SILENTLY skip that package ("already published", exit 0). The registry is throwaway and
# freshly wiped, so an unconditional publish is exactly what we want.
echo "▶ publishing @birdybeep/* with pnpm…"
NPM_CONFIG_USERCONFIG="$NPMRC" pnpm -r publish --force --registry "$REGISTRY" --no-git-checks --access public

# ---- 6. Real global install from the local registry, into an isolated prefix ----
echo "▶ installing @birdybeep/cli globally into $GLOBAL_PREFIX …"
NPM_CONFIG_USERCONFIG="$NPMRC" npm install -g @birdybeep/cli --registry "$REGISTRY" --prefix "$GLOBAL_PREFIX"

BIN="$GLOBAL_PREFIX/bin/birdybeep"
echo "▶ running the installed binary:"
"$BIN" --version
"$BIN" --help

cat <<EOF

✓ rehearsal passed — @birdybeep/cli installed from a local registry and ran.
  binary:   $BIN
  registry: $REGISTRY (stops when this script exits)

To poke at it more before it tears down, open another terminal and run:
  npm --registry $REGISTRY view @birdybeep/cli
  $BIN doctor
Re-running this script wipes $WORK and starts clean.
EOF
