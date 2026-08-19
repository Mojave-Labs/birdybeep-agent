/**
 * CC-DETECT proof: HOME-relative, side-effect-free detection over a hermetic temp
 * HOME — present (dir and/or binary), absent (no throw, no files), and settings-path
 * resolution following $HOME.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { claudeCodeAdapter } from "./adapter";
import { claudeCodeSurfaces, detectClaudeCode } from "./detect";
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

/**
 * Surfaces (birdybeep-agent-gcgp.6): Claude Code runs from two independent installs on one
 * machine — the terminal CLI on PATH and the engine the desktop app manages — and they drift.
 * Every probe here is filesystem-only; nothing is executed.
 */
describe("claudeCodeSurfaces", () => {
  function desktopBuild(box: Sandbox, version: string): void {
    const dir = join(
      box.home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
      version,
      "claude.app",
      "Contents",
      "MacOS",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude"), "", { mode: 0o755 });
  }

  function terminalBuild(box: Sandbox, version: string): string {
    const dir = join(box.home, ".local", "share", "claude", "versions", version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude"), "", { mode: 0o755 });
    return dir;
  }

  it("reports the terminal CLI and the desktop engine as separate builds", () => {
    sandbox = createSandbox();
    const binDir = terminalBuild(sandbox, "2.1.227");
    desktopBuild(sandbox, "2.1.229");

    const surfaces = claudeCodeSurfaces({
      home: sandbox.home,
      platform: "darwin",
      env: { PATH: binDir },
    });

    expect(surfaces.map((s) => [s.id, s.kind, s.version])).toEqual([
      ["terminal", "terminal", "2.1.227"],
      ["desktop", "desktop", "2.1.229"],
    ]);
    // Both read the same settings file — one install action covers both rows.
    expect(new Set(surfaces.map((s) => s.configPath))).toEqual(
      new Set([claudeSettingsPath(sandbox.home)]),
    );
  });

  it("falls back to the probed version for the CLI PATH actually resolves", () => {
    sandbox = createSandbox();
    const binDir = join(sandbox.home, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "claude"), "", { mode: 0o755 });

    const surfaces = claudeCodeSurfaces({
      home: sandbox.home,
      platform: "darwin",
      env: { PATH: binDir },
      probedVersion: "2.1.227",
    });
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.version).toBe("2.1.227");
  });

  it("lists every managed desktop build, newest first", () => {
    sandbox = createSandbox();
    desktopBuild(sandbox, "2.1.228");
    desktopBuild(sandbox, "2.1.229");
    const surfaces = claudeCodeSurfaces({
      home: sandbox.home,
      platform: "darwin",
      env: { PATH: "" },
    });
    expect(surfaces.map((s) => s.version)).toEqual(["2.1.229", "2.1.228"]);
    expect(surfaces.map((s) => s.id)).toEqual(["desktop", "desktop-2"]);
  });

  it("ignores a managed build directory with no engine in it", () => {
    sandbox = createSandbox();
    mkdirSync(
      join(sandbox.home, "Library", "Application Support", "Claude", "claude-code", "2.1.230"),
      { recursive: true },
    );
    expect(
      claudeCodeSurfaces({ home: sandbox.home, platform: "darwin", env: { PATH: "" } }),
    ).toEqual([]);
  });

  it("reports no desktop surface off macOS rather than guessing a path", () => {
    sandbox = createSandbox();
    desktopBuild(sandbox, "2.1.229");
    expect(
      claudeCodeSurfaces({ home: sandbox.home, platform: "linux", env: { PATH: "" } }),
    ).toEqual([]);
  });
});
