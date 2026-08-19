/**
 * birdybeep-agent-gcgp.16 REGRESSION (OpenCode) — the SILENT DROP, reproduced by actually driving
 * the real plugin and watching whether the CLI ever runs.
 *
 * OpenCode is the one adapter that writes no command string into a harness config: the plugin
 * spawns the CLI itself, at runtime, and it resolved the bare name `birdybeep` on PATH. So on a
 * machine whose OpenCode was not launched from the user's shell, there is no exit-127 line in any
 * hook log to find — the CLI is simply never found and EVERY event vanishes. That makes this the
 * adapter most likely to be quietly broken in the wild, and the one whose failure is hardest to
 * diagnose.
 *
 * The fix is the same launcher every other adapter now writes (absolute Node + absolute CLI
 * entry), recorded at install time in the BirdyBeep data dir and preferred by the plugin over any
 * PATH lookup. Evidence here is a receipt written BY THE SPAWNED PROCESS — not a mocked spawn.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname } from "node:path";

import { resolveHookLauncher } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installOpenCode,
  opencodeLauncherPath,
  readOpenCodeLauncher,
  staleOpenCodeLauncherPaths,
  writeOpenCodeLauncher,
} from "./install";
import { BirdyBeepPlugin } from "./plugin";
import { uninstallOpenCode } from "./uninstall";

const POSIX = process.platform !== "win32";

let sandbox: Sandbox | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  sandbox?.cleanup();
  sandbox = undefined;
});

const RAW_CWD = "/Users/dev/code/project";

interface Rig {
  bin: string;
  emptyPath: string;
  receipt: string;
}

/** A stand-in for the published CLI that records what it was handed. */
function buildRig(sb: Sandbox): Rig {
  const binDir = sb.path("tools");
  const emptyPath = sb.path("empty-path");
  for (const dir of [binDir, emptyPath]) mkdirSync(dir, { recursive: true });
  const receipt = sb.path("receipt.json");
  const bin = `${binDir}/birdybeep`;
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let stdin = '';",
      "process.stdin.on('data', (c) => { stdin += c; });",
      "process.stdin.on('end', () => {",
      `  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({`,
      "    args: process.argv.slice(2), stdin,",
      "  }));",
      "});",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  // The whole point: OpenCode was launched WITHOUT the user's shell PATH.
  vi.stubEnv("PATH", emptyPath);
  return { bin, emptyPath, receipt };
}

/** The launcher a real install on this machine resolves, pointed at the rig's stub bin. */
function rigLauncher(rig: Rig) {
  return resolveHookLauncher({
    env: {},
    execPath: process.execPath,
    argv: [process.execPath, rig.bin],
  });
}

/** Wait for the spawned CLI to write its receipt (fire-and-forget: it is not awaited). */
async function waitForReceipt(path: string, timeoutMs = 5000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        /* still being written — retry */
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/** Write raw bytes at the launcher-record path, creating its directory (install normally does). */
function seedLauncherFile(contents: string): void {
  const path = opencodeLauncherPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

describe.skipIf(!POSIX)("gcgp.16: the OpenCode plugin's spawn", () => {
  it("REPRO — with no recorded launcher and no PATH, the event is DROPPED", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Install, but pretend it never recorded a launcher (the pre-gcgp.16 world).
    await installOpenCode({}, sb.home);
    seedLauncherFile("{}\n"); // present but unusable → no argv
    expect(readOpenCodeLauncher()).toBeNull();

    const hooks = await BirdyBeepPlugin({ directory: RAW_CWD });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });

    expect(await waitForReceipt(rig.receipt, 1500)).toBeNull(); // the CLI never ran
    // Not literally silent any more (ticket erm), but a stderr line nobody reads is not delivery.
    expect(stderr).toHaveBeenCalled();
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/not found on PATH/i);
  });

  it("FIXED — the recorded launcher delivers the event despite an empty PATH", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    await installOpenCode({}, sb.home);
    // What a real install resolves on a machine where the CLI can be identified.
    expect(writeOpenCodeLauncher(rigLauncher(rig))).toBe(true);

    const hooks = await BirdyBeepPlugin({ directory: RAW_CWD });
    await hooks.event({
      event: { type: "permission.asked", properties: { id: "p1", sessionID: "s1" } },
    });

    const receipt = asRecord(await waitForReceipt(rig.receipt));
    expect(receipt["args"]).toEqual(["hook", "opencode"]);
    const envelope = asRecord(JSON.parse(String(receipt["stdin"])));
    expect(envelope["type"]).toBe("permission.asked");
    expect(envelope["cwd"]).toBe(RAW_CWD); // the plugin injects the workspace dir
  });

  /**
   * The stale-CLI-entry case. Validating only argv[0] reintroduced this ticket's own bug with a
   * different trigger: after an npm reinstall under a different prefix, Node still exists while
   * the recorded CLI entry does not — so the record looked valid, the plugin spawned Node against
   * a missing script and reported SUCCESS, suppressing the PATH fallback that would have worked.
   * The spawn succeeds, so no `error` event fires and Node's complaint goes to ignored stdio:
   * every event vanishes silently.
   *
   * The assertion that matters is not "the record is rejected" — it is that the event STILL
   * ARRIVES.
   */
  it("REPRO+FIXED — a record whose CLI entry is gone falls back to PATH and still DELIVERS", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    await installOpenCode({}, sb.home);
    // Node is real and present; only the CLI entry has moved away (npm reinstall / uninstall).
    seedLauncherFile(JSON.stringify({ argv: [process.execPath, sb.path("gone", "birdybeep")] }));
    // …and `birdybeep` IS resolvable on PATH, so the fallback can and must succeed. Node has to
    // be findable too: the stub carries the published bin's `#!/usr/bin/env node` shebang, so a
    // PATH holding `birdybeep` but no `node` fails with exit 127 — this ticket's own lesson, and
    // never the shape of a real machine where the CLI is installed.
    vi.stubEnv("PATH", [dirname(rig.bin), dirname(process.execPath)].join(delimiter));

    const hooks = await BirdyBeepPlugin({ directory: RAW_CWD });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });

    const receipt = asRecord(await waitForReceipt(rig.receipt));
    expect(receipt["args"], "the event was silently dropped instead of falling back").toEqual([
      "hook",
      "opencode",
    ]);
    const envelope = asRecord(JSON.parse(String(receipt["stdin"])));
    expect(envelope["type"]).toBe("session.idle");
  });

  it("delivers the tool hooks through the same path", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    await installOpenCode({}, sb.home);
    writeOpenCodeLauncher(rigLauncher(rig));

    const hooks = await BirdyBeepPlugin({ directory: RAW_CWD });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" });

    const receipt = asRecord(await waitForReceipt(rig.receipt));
    const envelope = asRecord(JSON.parse(String(receipt["stdin"])));
    expect(envelope["type"]).toBe("tool.execute.before");
  });
});

describe("gcgp.16: the launcher record itself", () => {
  it("is written by a real install, with strict perms and no token", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    await installOpenCode({}, sb.home);
    writeOpenCodeLauncher(rigLauncher(rig));

    const path = opencodeLauncherPath();
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toMatch(/bbm_|bearer |token/i);
    expect(raw).not.toContain(RAW_CWD); // no workspace path, no event content
    if (POSIX) expect(statSync(path).mode & 0o077).toBe(0); // owner-only (§15)
  });

  it("refuses a record whose program is relative, missing, or not a string", () => {
    sandbox = createSandbox();
    const sb = sandbox;
    buildRig(sb);
    for (const argv of [
      ["birdybeep", "hook"], // RELATIVE — the cwd-hijack vector safeSpawn exists to stop
      ["/nowhere/does/not/exist", "x"], // absolute but gone (a moved Node)
      [42, "x"], // not a string
      [], // empty
    ]) {
      seedLauncherFile(JSON.stringify({ argv }));
      expect(readOpenCodeLauncher(), JSON.stringify(argv)).toBeNull();
    }
    seedLauncherFile("not json at all");
    expect(readOpenCodeLauncher()).toBeNull();
  });

  it("a bare (unresolvable) launcher records NOTHING and clears a stale record", () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    expect(writeOpenCodeLauncher(rigLauncher(rig))).toBe(true);
    expect(existsSync(opencodeLauncherPath())).toBe(true);

    // A later install from a context where the CLI cannot be identified (argv[1] is a test runner):
    // keeping the previous machine's absolute paths would be worse than having none.
    const bare = resolveHookLauncher({ env: {}, execPath: process.execPath, argv: ["node", "/x"] });
    expect(bare.source).toBe("bare");
    expect(writeOpenCodeLauncher(bare)).toBe(false);
    expect(existsSync(opencodeLauncherPath())).toBe(false);
  });

  it("an override is NOT recorded — it is a shell string, and the plugin uses no shell", () => {
    sandbox = createSandbox();
    buildRig(sandbox);
    const override = resolveHookLauncher({
      env: { BIRDYBEEP_HOOK_COMMAND: "mise exec -- birdybeep" },
    });
    expect(override.source).toBe("override");
    expect(writeOpenCodeLauncher(override)).toBe(false);
    expect(existsSync(opencodeLauncherPath())).toBe(false);
  });

  it("is refreshed by an idempotent re-install (how a user repairs a moved CLI)", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    const first = await installOpenCode({}, sb.home);
    expect(first.changed).toBe(true);
    writeOpenCodeLauncher(rigLauncher(rig));

    // Second install changes no config — but must still rewrite the launcher record.
    seedLauncherFile(JSON.stringify({ argv: ["/gone", "x"] }));
    const second = await installOpenCode({}, sb.home);
    expect(second.changed).toBe(false); // config untouched (idempotent)
    // The stale record was replaced by whatever THIS run resolves (bare under vitest → cleared).
    expect(readOpenCodeLauncher()).toBeNull();
  });

  it("rejects a record whose CLI ENTRY is gone, not just its Node (gcgp.16 P1)", () => {
    sandbox = createSandbox();
    const sb = sandbox;
    buildRig(sb);
    // argv[0] (Node) exists; argv[1] does not. The whole record must be refused.
    seedLauncherFile(JSON.stringify({ argv: [process.execPath, sb.path("gone", "birdybeep")] }));
    expect(readOpenCodeLauncher()).toBeNull();
  });

  it("reports exactly which recorded paths went stale, for doctor", () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    const gone = sb.path("gone", "birdybeep");

    expect(staleOpenCodeLauncherPaths()).toEqual([]); // no record at all
    writeOpenCodeLauncher(rigLauncher(rig));
    expect(staleOpenCodeLauncherPaths()).toEqual([]); // healthy

    seedLauncherFile(JSON.stringify({ argv: [process.execPath, gone] }));
    expect(staleOpenCodeLauncherPaths()).toEqual([gone]); // names the CLI entry, not Node
  });

  it("a stale record is left on disk for doctor to explain, never deleted on the event path", () => {
    sandbox = createSandbox();
    const sb = sandbox;
    buildRig(sb);
    seedLauncherFile(JSON.stringify({ argv: [process.execPath, sb.path("gone", "birdybeep")] }));

    expect(readOpenCodeLauncher()).toBeNull();
    // Reading must not mutate: the plugin runs this on EVERY event, in OpenCode's process.
    expect(existsSync(opencodeLauncherPath())).toBe(true);
  });

  it("uninstall clears it (it is a BirdyBeep-managed file)", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    await installOpenCode({}, sb.home);
    writeOpenCodeLauncher(rigLauncher(rig));
    expect(existsSync(opencodeLauncherPath())).toBe(true);

    await uninstallOpenCode({}, sb.home);
    expect(existsSync(opencodeLauncherPath())).toBe(false);
  });
});
