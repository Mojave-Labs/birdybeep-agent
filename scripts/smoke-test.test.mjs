import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NPM_CLI = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

function npmPack(args, options) {
  return process.platform === "win32"
    ? execFileSync(process.execPath, [NPM_CLI, ...args], options)
    : execFileSync("npm", args, options);
}

test(
  "consumer smoke exits non-zero when the installed package has no runnable bin",
  { timeout: 30_000 },
  () => {
    const fixture = mkdtempSync(join(tmpdir(), "birdybeep-broken-smoke-"));
    try {
      mkdirSync(join(fixture, "dist"), { recursive: true });
      writeFileSync(join(fixture, "dist", "placeholder.js"), "export {};\n");
      writeFileSync(
        join(fixture, "package.json"),
        `${JSON.stringify(
          {
            name: "@birdybeep/cli",
            version: "9.9.9-broken",
            type: "module",
            files: ["dist"],
            bin: { birdybeep: "dist/missing.js" },
          },
          null,
          2,
        )}\n`,
      );
      const packedOutput = JSON.parse(
        npmPack(["pack", "--json", "--pack-destination", fixture], {
          cwd: fixture,
          encoding: "utf8",
        }),
      );
      // npm 10 prints an array; newer npm prints an object keyed by package name.
      const packed = Array.isArray(packedOutput) ? packedOutput[0] : Object.values(packedOutput)[0];
      const tarball = join(fixture, packed.filename);
      const result = spawnSync(
        process.execPath,
        [join(ROOT, "scripts", "smoke-test.mjs"), "--package-spec", tarball, "--skip-build"],
        { cwd: ROOT, encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /installed binary is missing/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
