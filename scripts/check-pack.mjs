#!/usr/bin/env node
/**
 * REL-BUILD packaging guard (§16.3/§16.4): for every publishable package, assert the
 * `npm pack` tarball contains ONLY built output (`dist/` + package.json + readme/license)
 * — never `src`, tests, snapshots, configs, dotfiles, `.dev.vars`, or any secret material —
 * that no `workspace:*` specifier survives into the packed manifest, and that the CLI `bin`
 * carries a node shebang. Run after `pnpm build`. Exits non-zero on any violation so a bad
 * `files`/`exports`/`bin` change fails the build, not a future publish.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGES = ["agent-core", "claude-code", "codex", "opencode", "cli"];
const ALLOWED_TOP = new Set([
  "package.json",
  "README.md",
  "readme.md",
  "LICENSE",
  "LICENSE.md",
  "license",
]);
const FORBIDDEN = [
  /(^|\/)src\//,
  /\.test\./,
  /\.spec\./,
  /__snapshots__/,
  /\.dev\.vars/,
  /\.tgz$/,
  /(^|\/)\.[^/]/, // dotfiles
  /tsconfig|eslint|vitest|tsup/,
];

let failures = 0;
const fail = (pkg, msg) => {
  console.error(`  ✗ ${pkg}: ${msg}`);
  failures += 1;
};

for (const pkg of PACKAGES) {
  const dir = `packages/${pkg}`;

  // 1. Tarball allowlist (via npm pack --dry-run --json — no tarball written).
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" });
  const files = (JSON.parse(out)[0]?.files ?? []).map((f) => f.path);
  for (const f of files) {
    const top = f.split("/")[0];
    const allowed = f.startsWith("dist/") || ALLOWED_TOP.has(f) || ALLOWED_TOP.has(top);
    if (!allowed || FORBIDDEN.some((re) => re.test(f)))
      fail(pkg, `forbidden file would be packed: ${f}`);
  }
  if (!files.some((f) => f.startsWith("dist/")))
    fail(pkg, "no dist/ in tarball — run `pnpm build` first");

  // 2. No workspace:* in the packed manifest (pnpm pack must resolve it to a version).
  const tmp = mkdtempSync(join(tmpdir(), "bb-pack-"));
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", tmp], { cwd: dir, encoding: "utf8" });
    const tgz = readdirSync(tmp).find((n) => n.endsWith(".tgz"));
    if (tgz === undefined) {
      fail(pkg, "pnpm pack produced no tarball");
    } else {
      const manifest = execFileSync("tar", ["-xzOf", join(tmp, tgz), "package/package.json"], {
        encoding: "utf8",
      });
      if (manifest.includes("workspace:"))
        fail(pkg, "workspace:* survived into the packed manifest");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 3. The CLI bin carries a node shebang (so it runs as an executable).
const binFirstLine = readFileSync("packages/cli/dist/bin.js", "utf8").split("\n")[0];
if (!binFirstLine.startsWith("#!"))
  fail("cli", `dist/bin.js missing shebang (got: ${binFirstLine})`);

if (failures > 0) {
  console.error(`\n${failures} packaging check(s) failed.`);
  process.exit(1);
}
console.log(
  "✓ packaging checks passed: allowlist clean, no workspace:* leak, bin shebang present.",
);
