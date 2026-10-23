import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const fixture = (name) => new URL(`./fixtures/${name}.mjs`, import.meta.url).href;

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

test("NODE_OPTIONS preloads support spaces and URL-special characters in checkout paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "birdybeep Keychain #"));
  try {
    const path = join(dir, "no-keychain.mjs");
    copyFileSync(new URL("./fixtures/no-keychain.mjs", import.meta.url), path);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { spawn } from 'node:child_process';
      try { spawn('/usr/bin/security'); process.exitCode = 1; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    `,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${JSON.stringify(pathToFileURL(path).href)}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
