import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));

test("consumer smoke preload blocks the absolute Keychain executable", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      fixture("no-keychain"),
      "--input-type=module",
      "-e",
      `
    import { spawn } from 'node:child_process';
    try { spawn('/usr/bin/security', ['find-generic-password']); process.exitCode = 1; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("pairing preload routes absolute Keychain argv/stdin to an isolated fixture", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      fixture("keychain-shim"),
      "--input-type=module",
      "-e",
      `
    import { spawn } from 'node:child_process';
    const child = spawn('/usr/bin/security', ['-e', 'process.stdin.pipe(process.stdout)']);
    child.stdout.pipe(process.stdout);
    child.stdin.end('synthetic fixture input');
  `,
    ],
    { env: { ...process.env, BIRDYBEEP_TEST_SECURITY_SHIM: process.execPath }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "synthetic fixture input");
});
