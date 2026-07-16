/**
 * OC-PLUGIN-PACKAGE proof (hermetic temp HOME): load the BirdyBeep plugin, fire real
 * OpenCode-shaped events at its handlers, and assert each produces the correct normalized
 * BirdyBeep event delivered to the stub sink; that high-frequency events are filtered out
 * (never forwarded); that a forced send failure routes to the local queue instead of
 * throwing; that the needs_restart → installed marker flips on the first real event; and
 * that no token appears in anything the plugin writes. Full in-process OpenCode load is
 * exercised by OC-E2E.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSender, setToken, unavailableKeychainBackend } from "@birdybeep/agent-core";
import {
  createSandbox,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type BirdyBeepHooks, createBirdyBeepPlugin, type OpenCodeEventEnvelope } from "./plugin";
import {
  hasOpenCodeEventBeenSeen,
  opencodeRestartMarkerIsStrict,
  opencodeRestartMarkerPath,
  runOpenCodeHook,
} from "./restart";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };
const CWD = "/Users/dev/code/opencode-project";
const SID = "ses_plugin_1";

/**
 * Remove a temp dir, tolerating a lingering Windows handle. The delivery test spawns a real
 * `birdybeep` child whose cwd is its own bin dir (the trusted-cwd security behavior) and which
 * executes `shim.cjs` inside it; on Windows that dir (and the freshly-written `.cmd`/`.js`, which
 * Defender may briefly scan) stays LOCKED for a short while after the child writes its marker.
 * Cleanup of an OS temp dir is best-effort — the delivery/hijack ASSERTIONS run in the test body
 * and are unaffected; a leaked temp dir on an ephemeral CI runner is harmless. POSIX never locks.
 */
function removeDirBestEffort(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  } catch {
    /* a just-spawned child still holds the dir (EBUSY/EPERM); leave it for the runner to reap */
  }
}

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
});

/** Build a plugin whose hook delivery routes through the real in-process pipeline to the sink. */
async function loadPluginToSink(): Promise<BirdyBeepHooks> {
  sink = await StubEventSink.start();
  sandbox = createSandbox();
  await setToken(TOKEN, FILE_ONLY);
  const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });
  const plugin = createBirdyBeepPlugin({
    invokeHook: async (env: OpenCodeEventEnvelope) => {
      await runOpenCodeHook(env, { sender });
    },
  });
  return plugin({ directory: CWD });
}

function deliveredTypes(): string[] {
  return sink!.received().map((e) => (e.body as { event_type: string }).event_type);
}

describe("plugin forwards lifecycle events through the hook to the sink", () => {
  it("delivers the correct normalized event for each registered handler", async () => {
    const hooks = await loadPluginToSink();
    await hooks.event({ event: { type: "session.created", properties: { info: { id: SID } } } });
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: { id: "per_1", sessionID: SID, permission: "bash" },
      },
    });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } });
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: SID, callID: "c1" });

    const types = deliveredTypes();
    expect(types).toContain("session_started");
    expect(types).toContain("approval_required");
    expect(types).toContain("agent_idle");
    expect(types).toContain("tool_finished");
    expect(sink!.received()).toHaveLength(4);

    // Every delivered event carries the workspace cwd hashed (never raw).
    for (const e of sink!.received()) {
      expect((e.body as { workspace: { cwd: string } }).workspace.cwd).toMatch(/^h_[0-9a-f]{16}$/);
      expect((e.body as { harness: string }).harness).toBe("opencode");
    }
  });

  it("filters high-frequency / non-lifecycle bus events (never forwards them)", async () => {
    const calls: OpenCodeEventEnvelope[] = [];
    const plugin = createBirdyBeepPlugin({ invokeHook: (env) => void calls.push(env) });
    const hooks = await plugin({ directory: CWD });
    await hooks.event({ event: { type: "message.part.updated", properties: { delta: "x" } } });
    await hooks.event({ event: { type: "file.edited", properties: {} } });
    expect(calls).toHaveLength(0); // not in the allow-list → not forwarded
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } });
    expect(calls.map((c) => c.type)).toEqual(["session.idle"]); // only the lifecycle event forwarded
  });

  it("flips needs_restart → installed (records the marker) on the first real event", async () => {
    const hooks = await loadPluginToSink();
    expect(hasOpenCodeEventBeenSeen()).toBe(false); // plugin not yet proven live
    await hooks.event({ event: { type: "session.created", properties: { info: { id: SID } } } });
    expect(hasOpenCodeEventBeenSeen()).toBe(true);
    expect(opencodeRestartMarkerIsStrict()).toBe(true); // strict perms, no group/other access
    // The marker carries only a timestamp — never a token.
    expect(readFileSync(opencodeRestartMarkerPath(), "utf8")).not.toContain(TOKEN);
  });
});

describe("hook runner is non-blocking + queues on failure", () => {
  it("routes a forced send failure to the local queue instead of throwing", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const offline = createSender({
      baseUrl: "http://127.0.0.1:1",
      tokenOptions: FILE_ONLY,
      fetchImpl: () => Promise.reject(new Error("offline")),
    });
    const result = await runOpenCodeHook(
      { type: "session.idle", properties: { sessionID: SID }, cwd: CWD },
      { sender: offline },
    );
    expect(result.outcome).toBe("queued"); // swallowed into the queue, no throw
  });

  it("a dropped event (unmapped) is skipped and does not flip the marker", async () => {
    sandbox = createSandbox();
    sink = await StubEventSink.start();
    await setToken(TOKEN, FILE_ONLY);
    const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });
    const result = await runOpenCodeHook(
      { type: "permission.replied", properties: { sessionID: SID }, cwd: CWD },
      { sender },
    );
    expect(result.outcome).toBe("skipped");
    expect(sink.received()).toHaveLength(0);
    expect(hasOpenCodeEventBeenSeen()).toBe(false);
  });
});

/**
 * SECURITY (sec-review-2026-07 H1 / OC-DR8): exercise the REAL default delivery path
 * (`createBirdyBeepPlugin()` with no injected `invokeHook` → `defaultInvokeHook` → `safeSpawn`)
 * against a `birdybeep` shim on PATH while the process cwd is a hostile repo that has planted
 * its OWN `birdybeep` at its root. Runs on every OS (never skipped): on windows-latest it
 * reproduces the OS cwd-first resolution that the old `spawn("birdybeep …", { shell: true })`
 * fell victim to; on POSIX it still drives the real spawn end-to-end. Proves BOTH that delivery
 * works (dr8) and that the cwd binary is NEVER executed (H1).
 */
describe("defaultInvokeHook resolves birdybeep on PATH, never a cwd-planted binary (H1/dr8)", () => {
  const IS_WINDOWS = process.platform === "win32";
  const dirs: string[] = [];
  const makeDir = (p: string): string => {
    const d = mkdtempSync(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  let prevCwd: string | undefined;
  let prevPath: string | undefined;

  afterEach(() => {
    if (prevCwd !== undefined) process.chdir(prevCwd);
    if (prevPath !== undefined) process.env["PATH"] = prevPath;
    prevCwd = undefined;
    prevPath = undefined;
    vi.restoreAllMocks();
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d !== undefined) removeDirBestEffort(d);
    }
  });

  /** Plant a legit, node-backed `birdybeep` on PATH that records the delivered envelope. */
  function plantLegitOnPath(binDir: string, marker: string): void {
    const shimJs = join(binDir, "shim.cjs");
    writeFileSync(
      shimJs,
      `let d="";process.stdin.on("data",c=>d+=c);` +
        `process.stdin.on("end",()=>{require("fs").writeFileSync(${JSON.stringify(marker)},d);process.exit(0);});` +
        `process.stdin.resume();`,
    );
    if (IS_WINDOWS) {
      // Replicate the REAL `npm i -g` layout: the extensionless `birdybeep` (#!/bin/sh wrapper
      // for MSYS/Git-Bash) is co-located with `birdybeep.cmd` in the SAME on-PATH dir. The
      // resolver MUST pick the .cmd — CreateProcess can't launch the shebang wrapper, so
      // resolving it would drop this event and the assertion below would (correctly) fail. This
      // makes windows-latest CI exercise the npm-layout regression, not just an isolated .cmd.
      writeFileSync(
        join(binDir, "birdybeep"),
        `#!/bin/sh\nexec "${process.execPath}" "${shimJs}" "$@"\n`,
      );
      writeFileSync(join(binDir, "birdybeep.cmd"), `@"${process.execPath}" "${shimJs}" %*\r\n`);
    } else {
      const p = join(binDir, "birdybeep");
      writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${shimJs}" "$@"\n`);
      chmodSync(p, 0o755);
    }
  }

  /** Plant a hostile `birdybeep` in the (cwd) repo that writes `marker` if it is ever run. */
  function plantHostileInCwd(repo: string, marker: string): void {
    if (IS_WINDOWS) {
      writeFileSync(
        join(repo, "birdybeep.cmd"),
        `@echo off\r\n> ${JSON.stringify(marker)} echo x\r\n`,
      );
    } else {
      const p = join(repo, "birdybeep");
      writeFileSync(p, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
      chmodSync(p, 0o755);
    }
  }

  async function waitForFile(p: string, ms = 12000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (existsSync(p)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return existsSync(p);
  }

  it("delivers to the PATH birdybeep and never runs the cwd-planted one", async () => {
    const repo = makeDir("bb-oc-hostile-");
    const binDir = makeDir("bb-oc-legit-");
    const good = join(binDir, "DELIVERED.json");
    const pwned = join(repo, "PWNED");
    plantLegitOnPath(binDir, good);
    plantHostileInCwd(repo, pwned);

    prevCwd = process.cwd();
    prevPath = process.env["PATH"];
    process.chdir(repo); // the harness cwd == the hostile repo
    process.env["PATH"] = binDir; // only the legit birdybeep is on PATH

    const plugin = createBirdyBeepPlugin(); // NO deps → real defaultInvokeHook → safeSpawn
    const hooks = await plugin({ directory: repo });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: SID } } } });

    expect(await waitForFile(good)).toBe(true); // the PATH birdybeep received the event
    expect(readFileSync(good, "utf8")).toContain("session.created"); // …the exact envelope
    expect(existsSync(pwned)).toBe(false); // the cwd birdybeep was NEVER executed
  });

  it("drops the event with a one-time breadcrumb (never a bare-name fallback) when birdybeep is absent from PATH", async () => {
    const repo = makeDir("bb-oc-absent-");
    const emptyBin = makeDir("bb-oc-empty-");
    const pwned = join(repo, "PWNED");
    plantHostileInCwd(repo, pwned); // planted in cwd, but NOT on PATH

    prevCwd = process.cwd();
    prevPath = process.env["PATH"];
    process.chdir(repo);
    process.env["PATH"] = emptyBin; // birdybeep is nowhere on PATH
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const plugin = createBirdyBeepPlugin();
    const hooks = await plugin({ directory: repo });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: SID } } } });
    await new Promise((r) => setTimeout(r, 300));

    expect(existsSync(pwned)).toBe(false); // the cwd binary was NOT run (no bare-name fallback)
    // A breadcrumb was emitted so the drop isn't silent (once-per-process; this worker's first).
    const logged = errSpy.mock.calls.some((c) => String(c[0]).includes("birdybeep"));
    expect(logged).toBe(true);
  });
});
