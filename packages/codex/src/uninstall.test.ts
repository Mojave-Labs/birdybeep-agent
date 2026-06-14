/**
 * CX-UNINSTALL proof (hermetic temp HOME): install→uninstall round-trips a pre-existing
 * config byte-for-byte (incl. restoring a user's own single-valued notify that install
 * had to overwrite); post-install user edits survive a surgical strip; a from-scratch
 * BirdyBeep file is removed; uninstall is idempotent + a no-op on a clean config; and
 * the trust marker is cleared.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { parse } from "smol-toml";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { BIRDYBEEP_NOTIFY, isBirdyBeepHookEntry } from "./install";
import { installCodex } from "./install";
import { codexConfigFile } from "./paths";
import { hasCodexEventBeenSeen, recordCodexEventSeen } from "./trust";
import { uninstallCodex } from "./uninstall";

let sandbox: Sandbox | undefined;
const ORIGINAL = process.env["CODEX_HOME"];
beforeEach(() => delete process.env["CODEX_HOME"]);
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});
afterAll(() => {
  if (ORIGINAL !== undefined) process.env["CODEX_HOME"] = ORIGINAL;
});

const SEED_WITH_USER_HOOK = [
  'model = "o3"',
  'approval_policy = "on-request"',
  "",
  "[sandbox]",
  'mode = "workspace-write"',
  "",
  "[[hooks.PostToolUse]]",
  'matcher = "Bash"',
  "",
  "[[hooks.PostToolUse.hooks]]",
  'type = "command"',
  'command = "my-own-codex-hook"',
  "",
].join("\n");

function seed(home: string, body: string): string {
  const path = codexConfigFile({ home });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function noBirdyBeepEntriesRemain(path: string): boolean {
  const config = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const notifyManaged =
    Array.isArray(config["notify"]) &&
    (config["notify"] as unknown[]).join(" ") === [...BIRDYBEEP_NOTIFY].join(" ");
  const hooks = (config["hooks"] ?? {}) as Record<string, unknown>;
  const anyBBHook = Object.values(hooks).some(
    (entries) => Array.isArray(entries) && entries.some(isBirdyBeepHookEntry),
  );
  return !notifyManaged && !anyBBHook;
}

describe("round-trip restores the original byte-for-byte", () => {
  it("restores a pre-existing config (with a user hook) exactly", async () => {
    sandbox = createSandbox();
    const path = seed(sandbox.home, SEED_WITH_USER_HOOK);
    await installCodex({}, sandbox.home);
    const r = await uninstallCodex({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.restoredFiles).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe(SEED_WITH_USER_HOOK); // byte-for-byte
    expect(existsSync(`${path}.birdybeep-backup`)).toBe(false); // backup consumed
  });

  it("restores a user's own single-valued notify that install overwrote", async () => {
    sandbox = createSandbox();
    const userNotify = ['notify = ["user-notifier", "--flag"]', 'model = "o3"', ""].join("\n");
    const path = seed(sandbox.home, userNotify);
    await installCodex({}, sandbox.home); // overwrites notify with BirdyBeep's
    expect(parse(readFileSync(path, "utf8"))["notify"]).toEqual([...BIRDYBEEP_NOTIFY]);
    await uninstallCodex({}, sandbox.home);
    expect(readFileSync(path, "utf8")).toBe(userNotify); // user's notify restored, byte-for-byte
  });
});

describe("surgical strip preserves post-install user edits", () => {
  it("keeps a key the user added after install and removes only BirdyBeep entries", async () => {
    sandbox = createSandbox();
    const path = seed(sandbox.home, SEED_WITH_USER_HOOK);
    await installCodex({}, sandbox.home);
    // User edits the config AFTER install (append a new key).
    writeFileSync(path, `${readFileSync(path, "utf8")}\n[mcp_servers.local]\ncommand = "serve"\n`);

    const r = await uninstallCodex({}, sandbox.home);
    expect(r.changed).toBe(true);
    const config = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(config["mcp_servers"]).toEqual({ local: { command: "serve" } }); // user edit survives
    expect(config["model"]).toBe("o3"); // pre-install keys survive
    // The user's own pre-install hook survives; BirdyBeep entries are gone.
    expect(JSON.stringify(config["hooks"])).toContain("my-own-codex-hook");
    expect(noBirdyBeepEntriesRemain(path)).toBe(true);
  });
});

describe("from-scratch + idempotency + trust", () => {
  it("removes a config BirdyBeep created from scratch", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    await installCodex({}, sandbox.home); // creates config.toml from nothing
    expect(existsSync(path)).toBe(true);
    const r = await uninstallCodex({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.removedFiles).toEqual([path]);
    expect(existsSync(path)).toBe(false); // gone — back to the pre-install (absent) state
  });

  it("is a no-op on a clean (never-installed) config and does not throw", async () => {
    sandbox = createSandbox();
    const path = seed(sandbox.home, 'model = "o3"\n');
    const r = await uninstallCodex({}, sandbox.home);
    expect(r.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe('model = "o3"\n'); // untouched
  });

  it("is idempotent — a second uninstall is a no-op", async () => {
    sandbox = createSandbox();
    seed(sandbox.home, SEED_WITH_USER_HOOK);
    await installCodex({}, sandbox.home);
    await uninstallCodex({}, sandbox.home);
    const r2 = await uninstallCodex({}, sandbox.home);
    expect(r2.changed).toBe(false);
  });

  it("clears the trust marker on uninstall", async () => {
    sandbox = createSandbox();
    await installCodex({}, sandbox.home);
    recordCodexEventSeen();
    expect(hasCodexEventBeenSeen()).toBe(true);
    await uninstallCodex({}, sandbox.home);
    expect(hasCodexEventBeenSeen()).toBe(false);
  });
});
