#!/usr/bin/env node
/**
 * Post-build smoke test (§16.3, REL-SMOKE): pack EVERY package, then install `@birdybeep/cli`
 * (plus its workspace deps, all from local tarballs) into a CLEAN throwaway project OUTSIDE
 * the repo, and run the real `birdybeep` binary — proving the published-shape package installs
 * and runs like a real `npm install -g @birdybeep/cli`, not just that `pnpm build` succeeds.
 * Exits non-zero on any failure so CI catches a bad `exports`/`bin`/`files` before publish.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const PACKAGES = ["agent-core", "claude-code", "codex", "opencode", "cli"];
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });

console.log("▶ smoke: building all packages…");
run("pnpm", ["turbo", "build"], { stdio: "inherit" });

const tarDir = mkdtempSync(join(tmpdir(), "bb-smoke-tars-"));
const projDir = mkdtempSync(join(tmpdir(), "bb-smoke-proj-"));
let failed = false;

try {
  console.log("▶ packing 5 packages…");
  const tarballs = [];
  for (const pkg of PACKAGES) {
    run("pnpm", ["pack", "--pack-destination", tarDir], { cwd: join(ROOT, "packages", pkg) });
  }
  for (const f of readdirSync(tarDir)) if (f.endsWith(".tgz")) tarballs.push(resolve(tarDir, f));
  if (tarballs.length !== PACKAGES.length)
    throw new Error(`expected ${PACKAGES.length} tarballs, got ${tarballs.length}`);

  console.log("▶ installing @birdybeep/cli into a clean temp project (from tarballs)…");
  writeFileSync(
    join(projDir, "package.json"),
    `${JSON.stringify({ name: "bb-smoke", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  run("npm", ["install", "--no-fund", "--no-audit", ...tarballs], {
    cwd: projDir,
    stdio: "inherit",
  });

  const binJs = join(projDir, "node_modules", "@birdybeep", "cli", "dist", "bin.js");
  console.log("▶ running the installed `birdybeep`…");

  const version = run("node", [binJs, "--version"], { cwd: projDir }).trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`✗ birdybeep --version produced unexpected output: ${JSON.stringify(version)}`);
    failed = true;
  } else {
    console.log(`   birdybeep --version → ${version}  ✓`);
  }

  const help = run("node", [binJs, "--help"], { cwd: projDir });
  for (const cmd of ["login", "logout", "status", "test", "doctor", "agent", "hook"]) {
    if (!help.includes(cmd)) {
      console.error(`✗ birdybeep --help is missing command: ${cmd}`);
      failed = true;
    }
  }
  if (!failed) console.log("   birdybeep --help lists the full command surface  ✓");
} catch (err) {
  console.error(`✗ smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  failed = true;
} finally {
  rmSync(tarDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
}

if (failed) {
  console.error("\n✗ smoke test FAILED.");
  process.exit(1);
}
console.log(
  "\n✓ smoke test passed: @birdybeep/cli installs from a tarball and runs in a clean project.",
);
