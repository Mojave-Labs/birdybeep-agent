/**
 * CX-UNINSTALL proof (hermetic temp HOME): install→uninstall round-trips a pre-existing
 * config byte-for-byte (incl. restoring a user's own single-valued notify that install
 * had to overwrite); post-install user edits survive a surgical strip; a from-scratch
 * BirdyBeep file is removed; uninstall is idempotent + a no-op on a clean config; and
 * the trust marker is cleared.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { parse, stringify } from "smol-toml";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { isBirdyBeepHookEntry, LEGACY_BIRDYBEEP_NOTIFY } from "./install";
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
    (config["notify"] as unknown[]).join(" ") === [...LEGACY_BIRDYBEEP_NOTIFY].join(" ");
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

  it("round-trips a config whose notify belongs to another tool, untouched throughout", async () => {
    sandbox = createSandbox();
    const userNotify = ['notify = ["user-notifier", "--flag"]', 'model = "o3"', ""].join("\n");
    const path = seed(sandbox.home, userNotify);
    await installCodex({}, sandbox.home); // never writes notify (gcgp.2)
    expect(parse(readFileSync(path, "utf8"))["notify"]).toEqual(["user-notifier", "--flag"]);
    await uninstallCodex({}, sandbox.home);
    expect(readFileSync(path, "utf8")).toBe(userNotify); // byte-for-byte
  });
});

/**
 * birdybeep-agent-gcgp.2 regression: the third party that owns Codex's single `notify` slot
 * may re-claim it with a DIFFERENT value after our install (the owner's machine, where
 * Codex Computer Use re-took the slot and chained through to us). Uninstall must not write
 * a stale backup value over it.
 */
describe("uninstall under third-party notify chaining", () => {
  it("leaves a re-claimed third-party notify exactly as found", async () => {
    sandbox = createSandbox();
    const original = ['notify = ["other-tool", "turn-ended"]', 'model = "o3"', ""].join("\n");
    const path = seed(sandbox.home, original);
    await installCodex({}, sandbox.home);

    // The third party re-claims the slot with a chained value AFTER our install.
    const chained = [
      "other-tool",
      "turn-ended",
      "--previous-notify",
      '["birdybeep","hook","codex"]',
    ];
    const parsed = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    parsed["notify"] = chained;
    writeFileSync(path, `${stringify(parsed)}\n`);

    await uninstallCodex({}, sandbox.home);

    const after = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(after["notify"]).toEqual(chained); // their CURRENT value, not the backup's
    expect(noBirdyBeepEntriesRemain(path)).toBe(true);
  });

  /**
   * The migration path end-to-end, on the shape of the owner's real machine: an older
   * BirdyBeep owns the slot and the canonical backup still holds the third party's original.
   * Install must give it back, and a LATER uninstall must not take it away again — that
   * sequence is where the value would otherwise be lost for good (live value already gone,
   * canonical backup consumed by the uninstall).
   */
  it("a displaced third-party notify is restored by install and survives uninstall", async () => {
    sandbox = createSandbox();
    const original = 'notify = ["other-tool", "turn-ended"]\nmodel = "o3"\n';
    const path = codexConfigFile({ home: sandbox.home });
    // As an OLD BirdyBeep left it: our argv live, their value preserved in the backup.
    seed(sandbox.home, `notify = ${JSON.stringify([...LEGACY_BIRDYBEEP_NOTIFY])}\nmodel = "o3"\n`);
    writeFileSync(`${path}.birdybeep-backup`, original);

    await installCodex({}, sandbox.home);
    const migrated = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(migrated["notify"]).toEqual(["other-tool", "turn-ended"]); // handed back, not deleted

    await uninstallCodex({}, sandbox.home);
    const after = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(after["notify"]).toEqual(["other-tool", "turn-ended"]); // still theirs
    expect(after["model"]).toBe("o3");
    expect(noBirdyBeepEntriesRemain(path)).toBe(true);
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

  it("leaves no BirdyBeep files behind on the ordinary round-trip", async () => {
    sandbox = createSandbox();
    const path = seed(sandbox.home, SEED_WITH_USER_HOOK);
    await installCodex({}, sandbox.home);
    await uninstallCodex({}, sandbox.home);
    const leftovers = readdirSync(dirname(path)).filter((f) => f.includes("birdybeep"));
    expect(leftovers).toEqual([]);
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
