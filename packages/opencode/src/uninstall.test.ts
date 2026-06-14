/**
 * OC-UNINSTALL proof (hermetic temp HOME): install→uninstall round-trips a pre-existing
 * config byte-for-byte; a user's own plugin + post-install edits survive a surgical strip;
 * a from-scratch BirdyBeep file is removed; uninstall is idempotent + a no-op on a clean
 * config; and the restart marker is cleared.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { BIRDYBEEP_PLUGIN_REF, installOpenCode } from "./install";
import { opencodeConfigFile } from "./paths";
import { hasOpenCodeEventBeenSeen, recordOpenCodeEventSeen } from "./restart";
import { uninstallOpenCode } from "./uninstall";

let sandbox: Sandbox | undefined;
const ORIGINAL_XDG = process.env["XDG_CONFIG_HOME"];
beforeEach(() => delete process.env["XDG_CONFIG_HOME"]);
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});
afterAll(() => {
  if (ORIGINAL_XDG !== undefined) process.env["XDG_CONFIG_HOME"] = ORIGINAL_XDG;
});

function seed(home: string, value: unknown): string {
  const path = opencodeConfigFile({ home });
  mkdirSync(dirname(path), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, raw);
  return raw;
}
function readConfig(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("round-trip restores the original byte-for-byte", () => {
  it("restores a pre-existing config (with a user plugin) exactly", async () => {
    sandbox = createSandbox();
    const path = opencodeConfigFile({ home: sandbox.home });
    const original = seed(sandbox.home, { theme: "dark", plugin: ["user-plugin"], model: "x" });
    await installOpenCode({}, sandbox.home);
    const r = await uninstallOpenCode({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.restoredFiles).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe(original); // byte-for-byte
    expect(existsSync(`${path}.birdybeep-backup`)).toBe(false); // backup consumed
  });
});

describe("surgical strip preserves post-install user edits", () => {
  it("keeps a key added after install and removes only the BirdyBeep entry", async () => {
    sandbox = createSandbox();
    const path = opencodeConfigFile({ home: sandbox.home });
    seed(sandbox.home, { theme: "dark", plugin: ["user-plugin"] });
    await installOpenCode({}, sandbox.home);
    // User edits after install (append a key).
    const cfg = readConfig(path);
    cfg["keybinds"] = { leader: "ctrl+x" };
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);

    const r = await uninstallOpenCode({}, sandbox.home);
    expect(r.changed).toBe(true);
    const after = readConfig(path);
    expect(after["keybinds"]).toEqual({ leader: "ctrl+x" }); // user edit survives
    expect(after["theme"]).toBe("dark");
    expect(after["plugin"]).toEqual(["user-plugin"]); // user plugin kept, BirdyBeep removed
    expect((after["plugin"] as string[]).includes(BIRDYBEEP_PLUGIN_REF)).toBe(false);
  });
});

describe("from-scratch + idempotency + restart marker", () => {
  it("removes a config BirdyBeep created from scratch (plugin array pruned, file gone)", async () => {
    sandbox = createSandbox();
    const path = opencodeConfigFile({ home: sandbox.home });
    await installOpenCode({}, sandbox.home); // creates opencode.json with only our plugin entry
    expect(existsSync(path)).toBe(true);
    const r = await uninstallOpenCode({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.removedFiles).toEqual([path]);
    expect(existsSync(path)).toBe(false); // back to the pre-install (absent) state
  });

  it("is a no-op on a clean (never-installed) config and does not throw", async () => {
    sandbox = createSandbox();
    const path = opencodeConfigFile({ home: sandbox.home });
    const original = seed(sandbox.home, { theme: "dark" });
    const r = await uninstallOpenCode({}, sandbox.home);
    expect(r.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(original); // untouched
  });

  it("is idempotent — a second uninstall is a no-op", async () => {
    sandbox = createSandbox();
    seed(sandbox.home, { theme: "dark", plugin: ["user-plugin"] });
    await installOpenCode({}, sandbox.home);
    await uninstallOpenCode({}, sandbox.home);
    const r2 = await uninstallOpenCode({}, sandbox.home);
    expect(r2.changed).toBe(false);
  });

  it("clears the restart marker on uninstall", async () => {
    sandbox = createSandbox();
    await installOpenCode({}, sandbox.home);
    recordOpenCodeEventSeen();
    expect(hasOpenCodeEventBeenSeen()).toBe(true);
    await uninstallOpenCode({}, sandbox.home);
    expect(hasOpenCodeEventBeenSeen()).toBe(false);
  });
});
