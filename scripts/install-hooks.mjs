// Auto-installed via the root `prepare` script (runs on every `pnpm install`).
//
// beads owns git's core.hooksPath (.beads/hooks). Rather than fight it, we CHAIN
// the BirdyBeep pre-push gate by appending a managed block OUTSIDE the beads
// `--- BEGIN/END BEADS INTEGRATION ---` markers, so the hook runs: beads sync →
// our gate. This is idempotent and self-healing: if `bd hooks install` ever
// rewrites the shim, the next `pnpm install` re-applies the block. Never fails install.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const HOOK = ".beads/hooks/pre-push";
const BEGIN = "# --- BEGIN BIRDYBEEP PRE-PUSH GATE ---";
const END = "# --- END BIRDYBEEP PRE-PUSH GATE ---";
const BLOCK = `${BEGIN}
# Managed by scripts/install-hooks.mjs (A-PREPUSH). Runs AFTER beads sync.
# Bypassing with --no-verify defeats the agentic-first testing mandate.
_bb_root=$(git rev-parse --show-toplevel 2>/dev/null || echo .)
if [ -f "$_bb_root/scripts/pre-push.mjs" ]; then
  node "$_bb_root/scripts/pre-push.mjs" || exit $?
fi
${END}`;

try {
  if (!existsSync(HOOK)) {
    console.error(
      `birdybeep: ${HOOK} not found (beads hooks not installed yet) — skipping pre-push gate wiring.`,
    );
    process.exit(0);
  }
  let content = readFileSync(HOOK, "utf8");
  if (content.includes(BEGIN)) {
    process.exit(0); // already chained
  }
  if (!content.endsWith("\n")) content += "\n";
  content += `\n${BLOCK}\n`;
  writeFileSync(HOOK, content);
  chmodSync(HOOK, 0o755);
  console.error("birdybeep: chained pre-push gate into .beads/hooks/pre-push");
} catch (err) {
  console.error(
    `birdybeep: could not wire pre-push gate (${err.message}) — continuing without it.`,
  );
}
