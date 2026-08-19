/**
 * CUR-DETECT proof: HOME-relative, side-effect-free detection over a hermetic temp HOME —
 * present (dir and/or binary), absent (no throw, no files), and hooks-path resolution
 * following $HOME.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { cursorAdapter } from "./adapter";
import { cursorSurfaces, detectCursor } from "./detect";
import { cursorHooksPath } from "./paths";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

describe("detect()", () => {
  it("detects Cursor when ~/.cursor exists and parses the probed version", async () => {
    sandbox = createSandbox();
    mkdirSync(sandbox.path(".cursor"), { recursive: true });
    writeFileSync(sandbox.path(".cursor", "hooks.json"), '{"version":1}\n');
    const r = await detectCursor({ probeVersion: () => Promise.resolve("2026.07.09-a3815c0") });
    expect(r.detected).toBe(true);
    expect(r.version).toBe("2026.07.09-a3815c0");
    expect(r.configPath).toBe(cursorHooksPath(sandbox.home));
    expect(r.configPath?.startsWith(sandbox.home)).toBe(true);
  });

  it("detects via the binary even without ~/.cursor", async () => {
    sandbox = createSandbox();
    const r = await detectCursor({ probeVersion: () => Promise.resolve("2026.07.09") });
    expect(r.detected).toBe(true);
    expect(r.version).toBe("2026.07.09");
  });

  it("returns not-detected (no throw, no files created) when absent", async () => {
    sandbox = createSandbox();
    const r = await detectCursor({ probeVersion: () => Promise.resolve(null) });
    expect(r.detected).toBe(false);
    expect(r.version).toBeUndefined();
    expect(existsSync(sandbox.path(".cursor"))).toBe(false); // created nothing
  });

  it("resolves the hooks path under the current $HOME", async () => {
    sandbox = createSandbox();
    mkdirSync(sandbox.path(".cursor"), { recursive: true });
    const r = await detectCursor({ probeVersion: () => Promise.resolve(null) });
    expect(r.configPath).toBe(sandbox.path(".cursor", "hooks.json"));
  });

  it("the adapter's detect() (no-arg, real homedir) resolves under the sandbox HOME", async () => {
    sandbox = createSandbox();
    mkdirSync(sandbox.path(".cursor"), { recursive: true });
    const r = await cursorAdapter.detect();
    expect(r.detected).toBe(true);
    expect(r.configPath).toBe(sandbox.path(".cursor", "hooks.json"));
  });
});

/**
 * Surfaces (birdybeep-agent-gcgp.6): Cursor.app and the standalone `cursor-agent` are separate
 * builds on separate release trains reading one `~/.cursor/hooks.json`. Nothing is executed:
 * `cursor-agent --version` was observed WRITING a Cursor config file, which is exactly the side
 * effect a coverage probe must not have.
 */
describe("cursorSurfaces", () => {
  function cliBuild(box: Sandbox, version: string): string {
    const dir = join(box.home, ".local", "share", "cursor-agent", "versions", version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cursor-agent"), "", { mode: 0o755 });
    return dir;
  }

  function cursorApp(box: Sandbox, version: string): string {
    const apps = join(box.home, "Applications");
    const app = join(apps, "Cursor.app", "Contents", "Resources", "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "Cursor", version }));
    return apps;
  }

  it("reports the CLI and the desktop app as separate builds on one hooks file", () => {
    sandbox = createSandbox();
    const bin = cliBuild(sandbox, "2026.07.09-a3815c0");
    const apps = cursorApp(sandbox, "3.15.6");

    const surfaces = cursorSurfaces({
      home: sandbox.home,
      platform: "darwin",
      applicationsDir: apps,
      env: { PATH: bin },
    });

    expect(surfaces.map((s) => [s.id, s.kind, s.version])).toEqual([
      ["terminal", "terminal", "2026.07.09-a3815c0"],
      ["desktop", "desktop", "3.15.6"],
    ]);
    expect(new Set(surfaces.map((s) => s.configPath))).toEqual(
      new Set([cursorHooksPath(sandbox.home)]),
    );
  });

  it("reports no desktop surface off macOS rather than guessing a path", () => {
    sandbox = createSandbox();
    const apps = cursorApp(sandbox, "3.15.6");
    expect(
      cursorSurfaces({
        home: sandbox.home,
        platform: "linux",
        applicationsDir: apps,
        env: { PATH: "" },
      }),
    ).toEqual([]);
  });
});
