/**
 * CX-DETECT proof: HOME/$CODEX_HOME-relative, side-effect-free detection over a
 * hermetic temp HOME — present (dir and/or binary), absent (no throw, no files),
 * config-home override honored, and read-only (config dir unchanged).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import {
  assertTreesEqual,
  captureTree,
  createSandbox,
  type Sandbox,
} from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectCodex } from "./detect";
import { codexConfigDir, codexConfigFile } from "./paths";

let sandbox: Sandbox | undefined;
const ORIGINAL_CODEX_HOME = process.env["CODEX_HOME"];

beforeEach(() => {
  delete process.env["CODEX_HOME"]; // default to ~/.codex under the sandbox HOME
});
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});
afterAll(() => {
  if (ORIGINAL_CODEX_HOME !== undefined) process.env["CODEX_HOME"] = ORIGINAL_CODEX_HOME;
});

describe("detect()", () => {
  it("detects Codex when ~/.codex exists and parses the probed version", async () => {
    sandbox = createSandbox();
    mkdirSync(codexConfigDir({ home: sandbox.home }), { recursive: true });
    const r = await detectCodex({
      home: sandbox.home,
      probeVersion: () => Promise.resolve("0.5.0"),
    });
    expect(r.detected).toBe(true);
    expect(r.version).toBe("0.5.0");
    expect(r.configPath).toBe(codexConfigFile({ home: sandbox.home }));
    expect(r.configPath?.startsWith(sandbox.home)).toBe(true);
  });

  it("detects via the binary even without a config dir", async () => {
    sandbox = createSandbox();
    const r = await detectCodex({
      home: sandbox.home,
      probeVersion: () => Promise.resolve("1.0.0"),
    });
    expect(r.detected).toBe(true);
  });

  it("returns not-detected (no throw, no files created) when absent", async () => {
    sandbox = createSandbox();
    const r = await detectCodex({ home: sandbox.home, probeVersion: () => Promise.resolve(null) });
    expect(r.detected).toBe(false);
    expect(r.detail).toMatch(/not found/i);
    expect(existsSync(codexConfigDir({ home: sandbox.home }))).toBe(false);
  });

  it("honors a $CODEX_HOME-style config-home override", async () => {
    sandbox = createSandbox();
    const codexHome = sandbox.path("custom-codex");
    mkdirSync(codexHome, { recursive: true });
    const r = await detectCodex({ codexHome, probeVersion: () => Promise.resolve(null) });
    expect(r.detected).toBe(true);
    expect(r.configPath).toBe(codexConfigFile({ codexHome }));
    expect(r.configPath?.startsWith(codexHome)).toBe(true);
  });

  it("is read-only — the config dir is unchanged after detect()", async () => {
    sandbox = createSandbox();
    const dir = codexConfigDir({ home: sandbox.home });
    mkdirSync(dir, { recursive: true });
    writeFileSync(codexConfigFile({ home: sandbox.home }), 'model = "o3"\n');
    const before = captureTree(dir);
    await detectCodex({ home: sandbox.home, probeVersion: () => Promise.resolve("0.5.0") });
    assertTreesEqual(before, captureTree(dir), "detect() must not mutate Codex config");
  });
});
