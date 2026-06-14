#!/usr/bin/env node
/**
 * Release orchestration (§16.3) — DRY-RUN BY DEFAULT so a real `npm publish` is always an
 * explicit, deliberate act. Default mode runs preflight + build + the packaging guard and
 * prints exactly what WOULD publish (via `npm pack --dry-run`, making ZERO registry calls),
 * then exits 0. A real publish requires BOTH `--publish` AND `RELEASE_CONFIRM=1`, a clean
 * tree, and npm auth — that last step is HUMAN-REQUIRED (A-HUMAN-NPM) and is never run here.
 *
 *   node scripts/release.mjs            # dry-run: plan only, no registry writes
 *   node scripts/release.mjs --publish  # real publish (gated; needs RELEASE_CONFIRM=1 + auth)
 */
import { execFileSync } from "node:child_process";

const PUBLISH = process.argv.includes("--publish");
// Dependency order: core first, adapters, then the CLI that depends on them.
const PACKAGES = ["agent-core", "claude-code", "codex", "opencode", "cli"];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const capture = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const abort = (msg) => {
  console.error(`\n✗ release aborted: ${msg}`);
  process.exit(1);
};

console.log(
  `▶ BirdyBeep release — mode: ${PUBLISH ? "PUBLISH" : "DRY-RUN (nothing is published)"}\n`,
);

// 1. Preflight — working tree.
const dirty = capture("git", ["status", "--porcelain"]).trim().length > 0;
if (dirty) {
  if (PUBLISH) abort("working tree is dirty — commit or stash before publishing.");
  console.warn("⚠ working tree is dirty (fine for a dry-run; would block a real publish).");
}

// 1b. Preflight — pending changesets (what `changeset version` would bump).
try {
  console.log("▶ changeset status:");
  run("pnpm", ["changeset:status"]);
} catch {
  console.warn(
    "⚠ `changeset status` reported pending/uncommitted release intent (review before publishing).",
  );
}

// In a real publish, apply versions FIRST so the built artifacts carry the new numbers.
if (PUBLISH) {
  if (process.env["RELEASE_CONFIRM"] !== "1") {
    abort(
      "real publish requires RELEASE_CONFIRM=1 — an explicit, deliberate act (and npm auth, A-HUMAN-NPM).",
    );
  }
  console.log("\n▶ applying versions (changeset version)…");
  run("pnpm", ["changeset:version"]);
}

// 2. Build everything.
console.log("\n▶ building all packages…");
run("pnpm", ["turbo", "build"]);

// 3. Packaging guard — refuse anything with src/tests/secrets or a workspace:* leak.
console.log("\n▶ verifying package tarballs…");
run("node", ["scripts/check-pack.mjs"]);

// 4. Plan — exactly what would be published, with ZERO registry contact.
console.log("\n▶ release plan (in dependency order):");
for (const pkg of PACKAGES) {
  const info = JSON.parse(
    capture("npm", ["pack", "--dry-run", "--json"], { cwd: `packages/${pkg}` }),
  )[0];
  const kb = (info.size / 1024).toFixed(1);
  console.log(
    `   ${info.name}@${info.version}  —  ${info.entryCount} files, ${kb} kB  (access: public)`,
  );
}

if (!PUBLISH) {
  console.log(
    "\n✓ dry-run complete — no registry calls were made. Re-run with `--publish RELEASE_CONFIRM=1` to release.",
  );
  process.exit(0);
}

// 5. Real publish (HUMAN-REQUIRED: needs an authenticated npm token; never run automatically).
console.log("\n▶ publishing (public access, dependency order)…");
run("pnpm", ["-r", "publish", "--access", "public", "--no-git-checks"]);
console.log("\n✓ published.");
