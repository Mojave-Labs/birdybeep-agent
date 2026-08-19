/**
 * CX-DETECT proof: HOME/$CODEX_HOME-relative, side-effect-free detection over a
 * hermetic temp HOME — present (dir and/or binary), absent (no throw, no files),
 * config-home override honored, and read-only (config dir unchanged).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import {
  assertTreesEqual,
  captureTree,
  createSandbox,
  type Sandbox,
} from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { codexSurfaces, detectCodex } from "./detect";
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

/**
 * Surfaces (birdybeep-agent-gcgp.6): a machine can carry several Codex builds at once — one npm
 * install per Node, plus the one bundled inside ChatGPT.app — and ALL of them read the same
 * `~/.codex/config.toml`. Filesystem-only: an npm build's version comes from its package.json,
 * and the bundled build's row carries no version because only the binary knows it.
 */
describe("codexSurfaces", () => {
  /**
   * An npm-installed Codex. A real install puts a symlink on PATH pointing INTO the package;
   * the fixture puts the entry at the symlink's target instead, which exercises the same
   * package.json walk without needing the Windows symlink privilege.
   */
  function npmCodex(box: Sandbox, prefix: string, version: string): string {
    const pkg = join(box.home, prefix, "lib", "node_modules", "@openai", "codex");
    const bin = join(pkg, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version }));
    writeFileSync(join(bin, "codex"), "", { mode: 0o755 });
    return bin;
  }

  function chatgptApp(box: Sandbox): string {
    const apps = join(box.home, "Applications");
    mkdirSync(join(apps, "ChatGPT.app", "Contents", "Resources"), { recursive: true });
    writeFileSync(join(apps, "ChatGPT.app", "Contents", "Resources", "codex"), "", { mode: 0o755 });
    return apps;
  }

  it("lists the ChatGPT-bundled build beside the CLI, all on one config file", () => {
    sandbox = createSandbox();
    const bin = npmCodex(sandbox, "nvm", "0.135.0");
    const apps = chatgptApp(sandbox);

    const surfaces = codexSurfaces({
      home: sandbox.home,
      platform: "darwin",
      applicationsDir: apps,
      env: { PATH: bin },
    });

    expect(surfaces.map((s) => [s.id, s.kind, s.label, s.version])).toEqual([
      ["terminal", "terminal", "terminal CLI", "0.135.0"],
      ["desktop", "desktop", "ChatGPT desktop app", undefined],
    ]);
    // Only the binary knows the bundled build's version — the row stays honest about that.
    expect(surfaces[1]?.version).toBeUndefined();
    expect(new Set(surfaces.map((s) => s.configPath))).toEqual(
      new Set([codexConfigFile({ home: sandbox.home })]),
    );
  });

  it("reports a second, shadowed CLI install rather than hiding it", () => {
    sandbox = createSandbox();
    const first = npmCodex(sandbox, "nvm", "0.135.0");
    const second = npmCodex(sandbox, "brew", "0.147.0");
    const surfaces = codexSurfaces({
      home: sandbox.home,
      platform: "linux",
      env: { PATH: [first, second].join(delimiter) },
    });
    expect(surfaces.map((s) => [s.id, s.version])).toEqual([
      ["terminal", "0.135.0"],
      ["terminal-2", "0.147.0"],
    ]);
    expect(surfaces[1]?.label).toContain("shadowed");
  });

  it("reports no ChatGPT surface off macOS rather than guessing a path", () => {
    sandbox = createSandbox();
    const apps = chatgptApp(sandbox);
    expect(
      codexSurfaces({
        home: sandbox.home,
        platform: "linux",
        applicationsDir: apps,
        env: { PATH: "" },
      }),
    ).toEqual([]);
  });
});
