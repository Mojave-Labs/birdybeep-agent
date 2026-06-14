/**
 * OC-DETECT proof (hermetic temp HOME): OpenCode present (config dir and/or a versioned
 * binary) → detected=true with the resolved config path; absent → detected=false (no
 * throw); a failed version probe → detected=true with version unknown. The resolved path
 * is always rooted under the temp HOME — never a real-user path. Read-only: detection
 * writes nothing.
 */
import { mkdirSync } from "node:fs";

import {
  assertTreesEqual,
  captureTree,
  createSandbox,
  type Sandbox,
} from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectOpenCode } from "./detect";
import { opencodeConfigDir, opencodeConfigFile } from "./paths";

let sandbox: Sandbox | undefined;
const ORIGINAL_XDG = process.env["XDG_CONFIG_HOME"];
// Force the home-relative path (ignore any ambient/sandbox XDG) for deterministic assertions.
beforeEach(() => delete process.env["XDG_CONFIG_HOME"]);
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});
afterAll(() => {
  if (ORIGINAL_XDG !== undefined) process.env["XDG_CONFIG_HOME"] = ORIGINAL_XDG;
});

const noBinary = () => Promise.resolve(null);
const withVersion = (v: string) => () => Promise.resolve(v);

describe("detectOpenCode", () => {
  it("detects via the config dir and resolves the config path under HOME", async () => {
    sandbox = createSandbox();
    mkdirSync(opencodeConfigDir({ home: sandbox.home }), { recursive: true });
    const r = await detectOpenCode({ home: sandbox.home, probeVersion: withVersion("0.5.1") });
    expect(r.detected).toBe(true);
    expect(r.version).toBe("0.5.1");
    expect(r.configPath).toBe(opencodeConfigFile({ home: sandbox.home }));
    expect(r.configPath!.startsWith(sandbox.home)).toBe(true); // never a real-user path
  });

  it("detects via the binary alone when the config dir is absent", async () => {
    sandbox = createSandbox();
    const r = await detectOpenCode({ home: sandbox.home, probeVersion: withVersion("0.5.1") });
    expect(r.detected).toBe(true);
    expect(r.version).toBe("0.5.1");
  });

  it("returns detected=false (no throw) when OpenCode is absent", async () => {
    sandbox = createSandbox();
    const r = await detectOpenCode({ home: sandbox.home, probeVersion: noBinary });
    expect(r.detected).toBe(false);
    expect(r.detail).toMatch(/not found/i);
    expect(r.version).toBeUndefined();
  });

  it("detected-but-version-unknown when the dir exists but the probe fails", async () => {
    sandbox = createSandbox();
    mkdirSync(opencodeConfigDir({ home: sandbox.home }), { recursive: true });
    const r = await detectOpenCode({ home: sandbox.home, probeVersion: noBinary });
    expect(r.detected).toBe(true);
    expect(r.version).toBeUndefined(); // graceful: detected without a version, not a crash
    expect(r.configPath).toBe(opencodeConfigFile({ home: sandbox.home }));
  });

  it("is read-only — detection writes nothing", async () => {
    sandbox = createSandbox();
    mkdirSync(opencodeConfigDir({ home: sandbox.home }), { recursive: true });
    const before = captureTree(opencodeConfigDir({ home: sandbox.home }));
    await detectOpenCode({ home: sandbox.home, probeVersion: withVersion("0.5.1") });
    const after = captureTree(opencodeConfigDir({ home: sandbox.home }));
    assertTreesEqual(before, after);
  });
});
