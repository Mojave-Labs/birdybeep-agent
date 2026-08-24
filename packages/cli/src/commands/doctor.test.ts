/**
 * `birdybeep doctor` proof (hermetic temp HOME): construct fault scenarios — no token, an
 * adapter reporting needs_trust / needs_restart / error, a non-empty queue, an unreachable
 * backend — and assert doctor detects each, prints the expected fix string, drains the
 * queue when reachable, mirrors findings under --json, and exits non-zero on any failure.
 * Doctor is read-only (it runs the adapters' read-only doctor()).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

import {
  type AgentAdapter,
  clearToken,
  createSender,
  type DoctorResult,
  setToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import { BIRDYBEEP_HOOK_COMMAND as CLAUDE_HOOK, installClaudeCode } from "@birdybeep/claude-code";
import {
  BIRDYBEEP_HOOK_COMMAND as CURSOR_HOOK,
  cursorConfigDir,
  cursorHooksPath,
  installCursor,
} from "@birdybeep/cursor";
import {
  createSandbox,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { type Command, EXIT } from "../framework";
import { createDoctorCommand, type DoctorCommandDeps } from "./doctor";
import { runHookCommand } from "./hook";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
});

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}

/** An adapter whose doctor() returns a fixed result (fault injection). */
function adapterWithDoctor(id: string, displayName: string, result: DoctorResult): AgentAdapter {
  return { id, displayName, doctor: () => Promise.resolve(result) } as AgentAdapter;
}

const codexUntrusted = adapterWithDoctor("codex", "Codex", {
  ok: false,
  checks: [
    {
      name: "Codex hooks trusted",
      ok: false,
      status: "needs_trust",
      remedy: "Open Codex and run /hooks",
    },
  ],
});
const opencodeNeedsRestart = adapterWithDoctor("opencode", "OpenCode", {
  ok: false,
  checks: [
    {
      name: "OpenCode plugin loaded",
      ok: false,
      status: "needs_restart",
      remedy: "Restart OpenCode",
    },
  ],
});

interface DoctorJson {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string; remedy?: string }[];
  queue: { depthBefore: number; delivered: number; depthAfter: number };
}

const BRIDGE_CHECK = "Approval beeps from Cursor";

/**
 * A `~/.cursor/hooks.json` owned entirely by ANOTHER tool — the shape a Cursor machine is in
 * before `agent install cursor` runs. None of the entries are ours, so the check must still fire.
 */
function writeForeignCursorHooks(home: string): void {
  mkdirSync(cursorConfigDir(home), { recursive: true });
  const foreign = [{ command: "/Users/dev/.othertool/hooks/cursor-notify.sh" }];
  writeFileSync(
    cursorHooksPath(home),
    JSON.stringify(
      {
        version: 1,
        hooks: { beforeSubmitPrompt: foreign, stop: foreign, beforeShellExecution: foreign },
      },
      null,
      2,
    ),
  );
}

/** doctor with the faults switched off, so only the check under test can fail. */
/**
 * A fetch that answers only the push-reachability read (birdybeep-agent-oi3). Everything else
 * doctor does is left alone, so these tests exercise exactly the new row.
 */
function reachabilityFetch(payload: unknown): typeof fetch {
  return ((url: string) =>
    String(url).includes("/v1/machine/push-reachability")
      ? Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
      : Promise.reject(new Error("unexpected fetch"))) as unknown as typeof fetch;
}

function bridgeDoctor(deps: DoctorCommandDeps = {}): Command {
  return createDoctorCommand({
    adapters: [],
    createSender: () => createSender({ baseUrl: "http://127.0.0.1:1", tokenOptions: FILE_ONLY }),
    tokenOptions: FILE_ONLY,
    probeNetwork: () => Promise.resolve(true),
    // Never the real API: these cases all have a paired token, so the push-reachability read
    // would otherwise issue an authenticated production request and stall on its timeout.
    baseUrl: "http://127.0.0.1:1",
    ...deps,
  });
}

describe("birdybeep doctor", () => {
  it("flags every fault with a fix, drains the queue, and exits non-zero (--json)", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    // Seed one queued event (failed earlier).
    const offline = createSender({
      baseUrl: "http://127.0.0.1:1",
      tokenOptions: FILE_ONLY,
      fetchImpl: () => Promise.reject(new Error("offline")),
    });
    await runHookCommand(
      "opencode",
      { type: "session.idle", properties: { sessionID: "s" }, cwd: "/tmp/x" },
      offline,
    );
    const sinkUrl = sink.url;

    const cmd = createDoctorCommand({
      adapters: [codexUntrusted, opencodeNeedsRestart],
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
      probeNetwork: () => Promise.resolve(false), // unreachable
    });
    const out = capture();
    const code = await runCli(["doctor", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.ERROR); // some checks failed
    const json = JSON.parse(out.text()) as DoctorJson;
    expect(json.ok).toBe(false);
    const byName = Object.fromEntries(json.checks.map((c) => [c.name, c]));
    expect(byName["Codex: Codex hooks trusted"]?.remedy).toMatch(/\/hooks/);
    expect(byName["OpenCode: OpenCode plugin loaded"]?.remedy).toMatch(/Restart OpenCode/);
    expect(byName["Backend reachable"]?.ok).toBe(false);
    // The queued event was drained to the (reachable) stub even though the probe said unreachable.
    expect(json.queue.depthBefore).toBe(1);
    expect(json.queue.delivered).toBe(1);
    expect(sink.received()).toHaveLength(1);
  });

  it("flags a missing token with the pair remedy", async () => {
    sandbox = createSandbox();
    await clearToken(FILE_ONLY);
    const cmd = createDoctorCommand({
      adapters: [],
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1", tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
      probeNetwork: () => Promise.resolve(true),
    });
    const out = capture();
    const code = await runCli(["doctor"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(out.text()).toMatch(/Machine token/);
    expect(out.text()).toMatch(/birdybeep pair/);
  });

  // gcgp.13: Cursor reads ~/.claude/settings.json and runs the hook commands it finds there, so
  // Claude-only installs deliver Cursor lifecycle events — minus approvals, which its bridge
  // drops. Doctor has to say so, and say it only while the gap is real.
  describe("Cursor running through the Claude Code bridge", () => {
    it("names the gap and recommends `agent install cursor` when only the Claude hooks exist", async () => {
      sandbox = createSandbox();
      await setToken(TOKEN, FILE_ONLY);
      await installClaudeCode({ hookCommand: CLAUDE_HOOK }, sandbox.home);
      writeForeignCursorHooks(sandbox.home); // Cursor present; nothing of ours in it

      const out = capture();
      const code = await runCli(["doctor"], {
        commands: [bridgeDoctor()], // real detectCursor: ~/.cursor exists in the sandbox
        stdout: out.writer,
        stderr: out.writer,
        ensureConfig: false,
      });

      expect(code).toBe(EXIT.ERROR);
      const text = out.text();
      expect(text).toContain(`✗  ${BRIDGE_CHECK}`);
      // WHY they see Cursor activity they never installed…
      expect(text).toMatch(/Cursor is running your agent through the Claude Code hooks/);
      expect(text).toMatch(/drops Notification and PermissionRequest/);
      // …and WHAT installing buys them.
      expect(text).toMatch(/→ Run `birdybeep agent install cursor`/);
      expect(text).toMatch(/approval beeps/);
      expect(text).toMatch(/duplicate events are collapsed/);
    });

    it("mirrors the finding under --json", async () => {
      sandbox = createSandbox();
      await setToken(TOKEN, FILE_ONLY);
      await installClaudeCode({ hookCommand: CLAUDE_HOOK }, sandbox.home);
      writeForeignCursorHooks(sandbox.home);

      const out = capture();
      const code = await runCli(["doctor", "--json"], {
        commands: [bridgeDoctor()],
        stdout: out.writer,
        stderr: out.writer,
        ensureConfig: false,
      });

      expect(code).toBe(EXIT.ERROR);
      const json = JSON.parse(out.text()) as DoctorJson;
      const check = json.checks.find((c) => c.name === BRIDGE_CHECK);
      expect(check?.ok).toBe(false);
      expect(check?.remedy).toMatch(/birdybeep agent install cursor/);
      expect(json.ok).toBe(false);
    });

    it("is silent once the Cursor adapter is installed (no nagging)", async () => {
      sandbox = createSandbox();
      await setToken(TOKEN, FILE_ONLY);
      await installClaudeCode({ hookCommand: CLAUDE_HOOK }, sandbox.home);
      writeForeignCursorHooks(sandbox.home);
      await installCursor({ hookCommand: CURSOR_HOOK }, sandbox.home); // the recommended fix

      const out = capture();
      const code = await runCli(["doctor", "--json"], {
        commands: [bridgeDoctor()],
        stdout: out.writer,
        stderr: out.writer,
        ensureConfig: false,
      });

      const json = JSON.parse(out.text()) as DoctorJson;
      expect(json.checks.map((c) => c.name)).not.toContain(BRIDGE_CHECK);
      expect(code).toBe(EXIT.OK); // nothing else failing → a clean run
    });

    it("is silent when Cursor is not on the machine", async () => {
      sandbox = createSandbox();
      await setToken(TOKEN, FILE_ONLY);
      await installClaudeCode({ hookCommand: CLAUDE_HOOK }, sandbox.home);

      const out = capture();
      const code = await runCli(["doctor", "--json"], {
        commands: [bridgeDoctor({ detectCursor: () => Promise.resolve({ detected: false }) })],
        stdout: out.writer,
        stderr: out.writer,
        ensureConfig: false,
      });

      const json = JSON.parse(out.text()) as DoctorJson;
      expect(json.checks.map((c) => c.name)).not.toContain(BRIDGE_CHECK);
      expect(code).toBe(EXIT.OK);
    });

    it("is silent when Cursor is present but BirdyBeep's Claude hooks are not installed", async () => {
      sandbox = createSandbox();
      await setToken(TOKEN, FILE_ONLY);
      writeForeignCursorHooks(sandbox.home); // Cursor, but nothing of ours anywhere

      const out = capture();
      const code = await runCli(["doctor", "--json"], {
        commands: [bridgeDoctor()],
        stdout: out.writer,
        stderr: out.writer,
        ensureConfig: false,
      });

      const json = JSON.parse(out.text()) as DoctorJson;
      expect(json.checks.map((c) => c.name)).not.toContain(BRIDGE_CHECK);
      expect(code).toBe(EXIT.OK);
    });
  });

  it("passes cleanly (exit 0) when token present, adapters healthy, backend reachable", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const healthy = adapterWithDoctor("claude_code", "Claude Code", {
      ok: true,
      checks: [{ name: "BirdyBeep hooks installed", ok: true }],
    });
    const cmd = createDoctorCommand({
      adapters: [healthy],
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1", tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
      probeNetwork: () => Promise.resolve(true),
    });
    const out = capture();
    const code = await runCli(["doctor", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect((JSON.parse(out.text()) as DoctorJson).ok).toBe(true);
  });
});

/**
 * birdybeep-agent-oi3 — the row that would have ended a multi-hour investigation in one command.
 * Every other check doctor runs is machine-side, so it printed a full green board while the
 * account's only device had been stale for five weeks and every push landed on a dead
 * registration: Expo ticket ok, receipt ok, nothing on the phone.
 */
describe("doctor: push reachability", () => {
  const reachable = {
    active_device_count: 1,
    stale_device_count: 0,
    most_recent_registration_at: new Date().toISOString(),
    last_delivery: { status: "ok", at: new Date().toISOString() },
  };

  it("FAILS when no device on the account can receive a beep", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const out = capture();
    const code = await runCli(["doctor"], {
      commands: [
        bridgeDoctor({
          fetchImpl: reachabilityFetch({
            ...reachable,
            active_device_count: 0,
            most_recent_registration_at: null,
          }),
        }),
      ],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(out.text()).toContain("Push reachability");
    expect(out.text()).toContain("No device can receive a beep");
    expect(out.text()).toContain("Open the BirdyBeep app");
  });

  it("FAILS when Expo has confirmed a token is dead", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const out = capture();
    const code = await runCli(["doctor"], {
      commands: [
        bridgeDoctor({ fetchImpl: reachabilityFetch({ ...reachable, stale_device_count: 2 }) }),
      ],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(out.text()).toContain("dead push token");
  });

  it("passes a healthy account and names the last push outcome", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const out = capture();
    await runCli(["doctor"], {
      commands: [bridgeDoctor({ fetchImpl: reachabilityFetch(reachable) })],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(out.text()).toContain("1 active device(s)");
    expect(out.text()).toContain("last push ok");
  });

  it("does NOT manufacture a failure when the check itself could not run", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const dead = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const out = capture();
    await runCli(["doctor"], {
      commands: [bridgeDoctor({ fetchImpl: dead })],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(out.text()).toContain("Could not check whether this account can receive a beep");
  });
});

/**
 * The beep-quota row (birdybeep-agent-58l) — the other invisible leg.
 *
 * A quota-blocked account and a healthy one produced identical doctor output: the backend
 * accepts an event with 202 and rejects it afterwards at the quota gate. For a month every
 * notifiable event on the owner's account was rejected while this command printed green.
 */
describe("doctor: beep quota", () => {
  const reachable = {
    active_device_count: 1,
    stale_device_count: 0,
    most_recent_registration_at: new Date().toISOString(),
    last_delivery: { status: "ok", at: new Date().toISOString() },
  };
  const withQuota = (over: Record<string, unknown>) => ({
    ...reachable,
    quota: {
      plan: "free",
      period_start: "2026-08-01T00:00:00.000Z",
      period_end: "2026-09-01T00:00:00.000Z",
      beeps_accepted: 3,
      beeps_limit: 100,
      exhausted: false,
      ...over,
    },
  });

  async function run(payload: unknown): Promise<{ code: number; text: string }> {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const out = capture();
    const code = await runCli(["doctor"], {
      commands: [bridgeDoctor({ fetchImpl: reachabilityFetch(payload) })],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    return { code, text: out.text() };
  }

  it("FAILS on an exhausted quota and names the reset date — exit non-zero", async () => {
    const { code, text } = await run(withQuota({ beeps_accepted: 100, exhausted: true }));
    expect(code).toBe(EXIT.ERROR);
    expect(text).toContain("Beep quota");
    expect(text).toContain("100/100 beeps");
    expect(text).toContain("2026-09-01");
  });

  it("prints BOTH window bounds on a healthy account, so a stuck window shows up", async () => {
    const { code, text } = await run(withQuota({}));
    expect(code).toBe(EXIT.OK);
    expect(text).toContain("3/100 beeps used (free plan, period 2026-08-01 → 2026-09-01)");
  });

  it("an older server that omits quota is informational — never a false FAIL", async () => {
    const { code, text } = await run(reachable);
    expect(code).toBe(EXIT.OK);
    expect(text).toContain("does not report beep quota yet");
  });

  it("--json carries the backend's raw quota block", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const out = capture();
    await runCli(["doctor", "--json"], {
      commands: [
        bridgeDoctor({
          fetchImpl: reachabilityFetch(withQuota({ beeps_accepted: 100, exhausted: true })),
        }),
      ],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    const parsed = JSON.parse(out.text()) as {
      quota?: { exhausted?: boolean; period_end?: string };
      checks: { name: string; ok: boolean }[];
    };
    expect(parsed.quota).toMatchObject({
      exhausted: true,
      period_end: "2026-09-01T00:00:00.000Z",
    });
    expect(parsed.checks.find((c) => c.name === "Beep quota")?.ok).toBe(false);
  });
});
