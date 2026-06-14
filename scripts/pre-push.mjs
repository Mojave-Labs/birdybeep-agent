// BirdyBeep pre-push gate (A-PREPUSH) — fast local feedback that mirrors CI.
//
// Runs the always-on gates (lint + typecheck + unit + format:check, exactly what CI
// enforces) and hard-blocks the push on any failure. The config-snapshot and adapter
// -smoke suites ride INSIDE `pnpm test` as they land (A-TEST-HARNESS / adapter
// tickets), so they are gated automatically without a separate step here — no
// hard-gating on suites that don't exist yet. CI + required status checks remain the
// authoritative, un-bypassable block; this hook just catches problems before they
// leave the machine. Chained AFTER beads sync via .beads/hooks/pre-push.
// Never --no-verify past a real failure.
import { execSync } from "node:child_process";

const RED = "\x1b[31m";
const GRN = "\x1b[32m";
const DIM = "\x1b[2m";
const RST = "\x1b[0m";
const B = "\x1b[1m";

function block(msg) {
  console.error(msg);
  process.exit(1);
}

// Always-on gates — mirror CI. Run on EVERY push.
console.error(`${DIM}birdybeep pre-push → lint + typecheck + unit + format (mirrors CI)…${RST}`);
try {
  execSync("pnpm -w turbo run lint typecheck test", { stdio: "inherit" });
} catch {
  block(
    `\n${RED}${B}✗ push blocked${RST} — lint/typecheck/unit failed (these mirror the CI gates).\n` +
      `  Fix the failures above, then push again. Do not bypass with --no-verify.`,
  );
}
try {
  execSync("pnpm -w format:check", { stdio: "inherit" });
} catch {
  block(
    `\n${RED}${B}✗ push blocked${RST} — Prettier formatting check failed.\n` +
      `  Run ${B}pnpm format${RST} to fix formatting, then push again.`,
  );
}

console.error(`${GRN}${B}✓ birdybeep pre-push passed${RST}`);
process.exit(0);
