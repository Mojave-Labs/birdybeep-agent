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
  installedBirdyBeepCommands,
  isBirdyBeepEntry,
  resolveCursorHookCommand,
} from "./install";
import { cursorHooksPath } from "./paths";
import { uninstallCursor } from "./uninstall";

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

describe("hook command resolution (gcgp.9 — the exit-127 fix)", () => {
  const ABSOLUTE = '"/opt/node/bin/node" "/opt/pnpm/birdybeep" hook cursor';

  it("registers beforeMCPExecution alongside its beforeShellExecution sibling", async () => {
    sandbox = createSandbox();
    await installCursor({}, sandbox.home);
    const parsed = readHooks(cursorHooksPath(sandbox.home));
    expect(entriesFor(parsed, "beforeMCPExecution").some(isBirdyBeepEntry)).toBe(true);
    // Same entry shape as the shell gate it mirrors.
    expect(entriesFor(parsed, "beforeMCPExecution")).toEqual(
      entriesFor(parsed, "beforeShellExecution"),
    );
  });

  it("writes the absolute command it is given, for every registered event", async () => {
    sandbox = createSandbox();
    const r = await installCursor({ hookCommand: ABSOLUTE }, sandbox.home);
    expect(r.changed).toBe(true);
    const parsed = readHooks(cursorHooksPath(sandbox.home));
    expect(installedBirdyBeepCommands(parsed)).toEqual([ABSOLUTE]);
    for (const event of BIRDYBEEP_HOOK_EVENTS) {
      expect(entriesFor(parsed, event)).toEqual([{ command: ABSOLUTE, timeout: 30 }]);
    }
  });

  it("REPAIRS a legacy bare entry in place — never leaves two hooks firing", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    // Exactly what an older BirdyBeep wrote (and what hit exit 127 in Cursor's own log).
    await installCursor({ hookCommand: "birdybeep hook cursor" }, sandbox.home);

    const r = await installCursor({ hookCommand: ABSOLUTE }, sandbox.home);
    expect(r.changed).toBe(true);
    const parsed = readHooks(hooks);
    expect(installedBirdyBeepCommands(parsed)).toEqual([ABSOLUTE]); // rewritten, not appended
    for (const event of BIRDYBEEP_HOOK_EVENTS) {
      expect(entriesFor(parsed, event)).toHaveLength(1);
    }
  });

  it("repairs a STALE absolute entry (CLI reinstalled elsewhere / node switched)", async () => {
    sandbox = createSandbox();
    await installCursor(
      { hookCommand: '"/gone/node-v20/bin/node" "/gone/birdybeep" hook cursor' },
      sandbox.home,
    );
    await installCursor({ hookCommand: ABSOLUTE }, sandbox.home);
    const parsed = readHooks(cursorHooksPath(sandbox.home));
    expect(installedBirdyBeepCommands(parsed)).toEqual([ABSOLUTE]);
  });

  it("still preserves a user's own hook while repairing ours", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    seedHooks(hooks, {
      version: 1,
      hooks: { sessionStart: [{ command: "superconductor-hook", timeout: 10 }] },
    });
    await installCursor({ hookCommand: "birdybeep hook cursor" }, sandbox.home);
    await installCursor({ hookCommand: ABSOLUTE }, sandbox.home);
    const start = entriesFor(readHooks(hooks), "sessionStart");
    expect(start).toHaveLength(2);
    expect(start[0]).toEqual({ command: "superconductor-hook", timeout: 10 });
    expect(start[1]).toEqual({ command: ABSOLUTE, timeout: 30 });
  });

  it("re-installing the SAME command is still a no-op (idempotent)", async () => {
    sandbox = createSandbox();
    await installCursor({ hookCommand: ABSOLUTE }, sandbox.home);
    const after = captureTree(sandbox.path(".cursor"));
    const r = await installCursor({ hookCommand: ABSOLUTE }, sandbox.home);
    expect(r.changed).toBe(false);
    assertTreesEqual(
      after,
      captureTree(sandbox.path(".cursor")),
      "same-command install is a no-op",
    );
  });

  it("uninstall removes an absolute-command entry as cleanly as a bare one", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    const original = seedHooks(hooks, {
      version: 1,
      hooks: { sessionStart: [{ command: "superconductor-hook", timeout: 10 }] },
    });
    await installCursor({ hookCommand: ABSOLUTE }, sandbox.home);
    await uninstallCursor({}, sandbox.home);
    expect(readFileSync(hooks, "utf8")).toBe(original);
  });

  // gcgp.9 follow-up: the tokenizer defect made the matcher blind to our own Windows entry, so
  // install would have APPENDED a second hook (double events) instead of rewriting in place.
  // Built as a literal Windows string so it runs on every host — the pre-push gate is macOS-only.
  it("recognizes a WINDOWS-shaped managed entry and repairs it instead of duplicating", async () => {
    sandbox = createSandbox();
    const windowsCommand =
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\x\\AppData\\Roaming\\npm\\birdybeep.cmd" hook cursor';
    await installCursor({ hookCommand: windowsCommand }, sandbox.home);
    expect(installedBirdyBeepCommands(readHooks(cursorHooksPath(sandbox.home)))).toEqual([
      windowsCommand,
    ]);

    await installCursor({ hookCommand: ABSOLUTE }, sandbox.home);
    const parsed = readHooks(cursorHooksPath(sandbox.home));
    expect(installedBirdyBeepCommands(parsed)).toEqual([ABSOLUTE]); // rewritten, not appended
    for (const event of BIRDYBEEP_HOOK_EVENTS) {
      expect(entriesFor(parsed, event)).toHaveLength(1);
    }
  });

  it("uninstall removes a WINDOWS-shaped managed entry too", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    const original = seedHooks(hooks, {
      version: 1,
      hooks: { sessionStart: [{ command: "superconductor-hook", timeout: 10 }] },
    });
    await installCursor(
      { hookCommand: '"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\birdybeep.cmd" hook cursor' },
      sandbox.home,
    );
    await uninstallCursor({}, sandbox.home);
    expect(readFileSync(hooks, "utf8")).toBe(original);
  });

  // gcgp.9 follow-up. Cursor entries are FLAT (one command each), so unlike Claude Code there is
  // no sibling command an entry-level repair could delete. But Cursor accepts `matcher`,
  // `loop_limit` and `failClosed` on an entry, so the repair must still edit rather than rebuild.
  it("repair preserves a customized timeout and unknown fields on our entry", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    seedHooks(hooks, {
      version: 1,
      hooks: {
        sessionStart: [
          { command: "birdybeep hook cursor", timeout: 90, failClosed: false, matcher: "*" },
        ],
      },
    });
    await installCursor({ hookCommand: ABSOLUTE }, sandbox.home);
    const start = entriesFor(readHooks(hooks), "sessionStart");
    expect(start).toHaveLength(1);
    expect(start[0]).toEqual({
      command: ABSOLUTE, // only the command changed
      timeout: 90, // NOT reset to our default 30
      failClosed: false,
      matcher: "*",
    });
  });

  it("defaults to the portable command when the installer is not the CLI", () => {
    // Under vitest, argv[1] is the test runner — resolution must NOT bake that in.
    expect(resolveCursorHookCommand()).toBe(BIRDYBEEP_HOOK_COMMAND);
    expect(BIRDYBEEP_HOOK_COMMAND).toBe("birdybeep hook cursor");
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
