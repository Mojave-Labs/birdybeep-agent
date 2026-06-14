/**
 * CC-DETECT proof: HOME-relative, side-effect-free detection over a hermetic temp
 * HOME — present (dir and/or binary), absent (no throw, no files), and settings-path
 * resolution following $HOME.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { claudeCodeAdapter } from "./adapter";
import { detectClaudeCode } from "./detect";
import { claudeSettingsPath } from "./paths";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

describe("detect()", () => {
  it("detects Claude Code when ~/.claude exists and parses the probed version", async () => {
    sandbox = createSandbox();
    mkdirSync(sandbox.path(".claude"), { recursive: true });
    writeFileSync(sandbox.path(".claude", "settings.json"), "{}\n");
    const r = await detectClaudeCode({ probeVersion: () => Promise.resolve("1.2.3") });
    expect(r.detected).toBe(true);
    expect(r.version).toBe("1.2.3");
    expect(r.configPath).toBe(claudeSettingsPath(sandbox.home));
    expect(r.configPath?.startsWith(sandbox.home)).toBe(true);
  });

  it("detects via the binary even without ~/.claude", async () => {
    sandbox = createSandbox();
    const r = await detectClaudeCode({ probeVersion: () => Promise.resolve("2.0.0") });
    expect(r.detected).toBe(true);
    expect(r.version).toBe("2.0.0");
  });

  it("returns not-detected (no throw, no files created) when absent", async () => {
    sandbox = createSandbox();
    const r = await detectClaudeCode({ probeVersion: () => Promise.resolve(null) });
    expect(r.detected).toBe(false);
    expect(r.version).toBeUndefined();
    expect(existsSync(sandbox.path(".claude"))).toBe(false); // created nothing
  });

  it("resolves the settings path under the current $HOME", async () => {
    sandbox = createSandbox();
    mkdirSync(sandbox.path(".claude"), { recursive: true });
    const r = await detectClaudeCode({ probeVersion: () => Promise.resolve(null) });
    expect(r.configPath).toBe(sandbox.path(".claude", "settings.json"));
  });

  it("the adapter's detect() (no-arg, real homedir) resolves under the sandbox HOME", async () => {
    sandbox = createSandbox();
    mkdirSync(sandbox.path(".claude"), { recursive: true });
    const r = await claudeCodeAdapter.detect();
    expect(r.detected).toBe(true);
    expect(r.configPath).toBe(sandbox.path(".claude", "settings.json"));
  });
});
