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
import { dirname } from "node:path";

import { resolveHookLauncher } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installOpenCode,
  opencodeLauncherPath,
  readOpenCodeLauncher,
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
