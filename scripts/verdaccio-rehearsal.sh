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

# Isolated npm/pnpm config: a dummy token (Verdaccio allows anonymous publish, but the
# npm client refuses to publish to a registry with no token set). Kept OUT of your ~/.npmrc.
cat > "$NPMRC" <<EOF
registry=$REGISTRY/
@birdybeep:registry=$REGISTRY/
//localhost:$PORT/:_authToken=local-anonymous-token
EOF
export NPM_CONFIG_USERCONFIG="$NPMRC"

# ---- 3. Start Verdaccio (kill it on any exit) ----
echo "▶ starting verdaccio…"
npx --yes verdaccio@6 --config "$CONFIG" --listen "$PORT" >"$LOG" 2>&1 &
VERDACCIO_PID=$!
trap 'echo "▶ stopping verdaccio (pid $VERDACCIO_PID)"; kill "$VERDACCIO_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1 || { echo "✗ verdaccio didn't come up. Log:"; tail -30 "$LOG"; exit 1; }
echo "✓ verdaccio up (log: $LOG)"

# ---- 4. Publish ALL packages with pnpm (resolves workspace:* → real versions) ----
echo "▶ publishing @birdybeep/* with pnpm…"
pnpm -r publish --registry "$REGISTRY" --no-git-checks --access public

# ---- 5. Real global install from the local registry, into an isolated prefix ----
echo "▶ installing @birdybeep/cli globally into $GLOBAL_PREFIX …"
npm install -g @birdybeep/cli --registry "$REGISTRY" --prefix "$GLOBAL_PREFIX"

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
