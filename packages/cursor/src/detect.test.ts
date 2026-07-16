/**
 * CUR-DETECT proof: HOME-relative, side-effect-free detection over a hermetic temp HOME —
 * present (dir and/or binary), absent (no throw, no files), and hooks-path resolution
 * following $HOME.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { cursorAdapter } from "./adapter";
import { detectCursor } from "./detect";
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
