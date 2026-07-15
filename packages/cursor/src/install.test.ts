/**
 * CUR-INSTALL proof (hermetic temp HOME): empty HOME → minimal valid hooks.json (version 1 +
 * the BirdyBeep hook block); realistic pre-existing hooks.json → only BB entries added, all
 * prior keys/hooks preserved, a user sessionStart hook kept alongside ours, backup byte-for-byte;
 * double-install idempotent; no token ever written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  assertTreeDelta,
  assertTreesEqual,
  captureTree,
  createSandbox,
  type Sandbox,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import {
  BIRDYBEEP_HOOK_COMMAND,
  BIRDYBEEP_HOOK_EVENTS,
  CURSOR_HOOKS_VERSION,
  installCursor,
  isBirdyBeepEntry,
} from "./install";
import { cursorHooksPath } from "./paths";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function readHooks(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
function entriesFor(config: Record<string, unknown>, event: string): unknown[] {
  const hooks = config["hooks"];
  const list =
    typeof hooks === "object" && hooks !== null
      ? (hooks as Record<string, unknown>)[event]
      : undefined;
  return Array.isArray(list) ? list : [];
}
function seedHooks(path: string, value: unknown): string {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, raw);
  return raw;
}

describe("install into an empty HOME", () => {
  it("creates a minimal valid hooks.json (version 1) with exactly the BirdyBeep hook block", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    const r = await installCursor({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.changedFiles).toEqual([hooks]);
    expect(r.backupFiles).toEqual([]); // nothing pre-existing to back up
    expect(r.requiredActions).toEqual([]); // no trust/restart gate
    expect(r.status).toBe("installed");

    const parsed = readHooks(hooks);
    expect(parsed["version"]).toBe(CURSOR_HOOKS_VERSION);
    for (const event of BIRDYBEEP_HOOK_EVENTS) {
      expect(entriesFor(parsed, event).some(isBirdyBeepEntry)).toBe(true);
    }
  });
});

describe("install over realistic pre-existing hooks config", () => {
  it("adds only BirdyBeep entries, preserves all prior keys + a user hook, and backs up", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    const original = {
      version: 1,
      hooks: {
        sessionStart: [{ command: "my-own-hook", timeout: 10 }],
        beforeShellExecution: [{ command: "my-audit-hook", timeout: 15 }],
      },
    };
    const originalRaw = seedHooks(hooks, original);
    const before = captureTree(sandbox.path(".cursor"));

    const r = await installCursor({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.backupFiles).toEqual([`${hooks}.birdybeep-backup`]);

    // Only BB-managed entries added at the file level: hooks.json changed + backup added.
    assertTreeDelta(before, captureTree(sandbox.path(".cursor")), {
      added: ["hooks.json.birdybeep-backup"],
      changed: ["hooks.json"],
    });
    // Backup is the original bytes, exactly.
    expect(readFileSync(`${hooks}.birdybeep-backup`, "utf8")).toBe(originalRaw);

    const parsed = readHooks(hooks);
    // The user's own hooks are preserved ALONGSIDE BirdyBeep's.
    const start = entriesFor(parsed, "sessionStart");
    expect(start.some((e) => JSON.stringify(e).includes("my-own-hook"))).toBe(true);
    expect(start.some(isBirdyBeepEntry)).toBe(true);
    const shell = entriesFor(parsed, "beforeShellExecution");
    expect(shell.some((e) => JSON.stringify(e).includes("my-audit-hook"))).toBe(true);
    expect(shell.some(isBirdyBeepEntry)).toBe(true);
    // Every registered event now carries a BirdyBeep entry.
    for (const event of BIRDYBEEP_HOOK_EVENTS) {
      expect(entriesFor(parsed, event).some(isBirdyBeepEntry)).toBe(true);
    }
  });

  it("is idempotent — a second install changes nothing", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    seedHooks(hooks, { version: 1, hooks: {} });
    await installCursor({}, sandbox.home);
    const afterFirst = captureTree(sandbox.path(".cursor"));
    const r2 = await installCursor({}, sandbox.home);
    expect(r2.changed).toBe(false);
    assertTreesEqual(afterFirst, captureTree(sandbox.path(".cursor")), "second install is a no-op");
  });
});

describe("security", () => {
  it("never writes a token; the hook references the command which reads the token at runtime", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    await installCursor({}, sandbox.home);
    const content = readFileSync(hooks, "utf8");
    expect(content).toContain(BIRDYBEEP_HOOK_COMMAND);
    expect(content.toLowerCase()).not.toContain("bearer ");
    expect(content).not.toMatch(/bbm_|token["']?\s*[:=]\s*["']\S/i);
    expect(existsSync(hooks)).toBe(true);
  });
});
