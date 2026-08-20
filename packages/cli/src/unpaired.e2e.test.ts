/**
 * birdybeep-agent-gcgp.4 E2E — "unpaired" must be distinguishable from "offline", visible from
 * the hot path, and unable to build a backlog that ambushes the user the moment they pair.
 *
 * Everything runs against a real install in a hermetic temp HOME, a LIVE stub backend (so the
 * machine is genuinely online throughout), and the real CLI dispatch → hook pipeline → sender →
 * queue path. What is asserted is what the wire saw and what the user can read on their screen.
 */
import { randomUUID } from "node:crypto";

import {
  type AgentAdapter,
  createSender,
  LocalEventQueue,
  normalizeEvent,
  readUnpairedNotice,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import { claudeCodeAdapter } from "@birdybeep/claude-code";
import {
  createSandbox,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli";
import { createAgentCommand } from "./commands/agent";
import { createDoctorCommand } from "./commands/doctor";
import { createHookCommand } from "./commands/hook";
import { createPairCommand } from "./commands/pair";
import { createStatusCommand } from "./commands/status";
import { createTestCommand } from "./commands/test";
import { EXIT } from "./framework";

const FILE_ONLY = { backend: unavailableKeychainBackend };
const MACHINE_TOKEN = `bbm_TESTONLY_${randomUUID()}`;

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

const detectedClaude: AgentAdapter = {
  ...claudeCodeAdapter,
  detect: () => Promise.resolve({ detected: true, version: "test" }),
};

/** One turn of a real Claude Code session: a permission prompt, then a stop. */
function claudeSession(id: string, cwd: string): string[] {
  const base = { session_id: id, cwd, transcript_path: `${cwd}/t.jsonl` };
  return [
    JSON.stringify({ ...base, hook_event_name: "SessionStart", source: "startup" }),
    JSON.stringify({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash" }),
    JSON.stringify({ ...base, hook_event_name: "Stop" }),
  ];
}

/** Minimal device-code backend: `/pair/start` opens a session, `/pair/token` mints at once. */
function stubPairing(): typeof fetch {
  return ((url: string | URL) => {
    if (String(url).endsWith("/v1/pair/start")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "dc_test",
            user_code: "AB-1234",
            qr_payload: `https://birdybeep.com/pair#code=AB-1234&s=${"ab".repeat(32)}`,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ machine_token: MACHINE_TOKEN, machine_id: "mac_1" }), {
        status: 201,
      }),
    );
  }) as unknown as typeof fetch;
}

const CONFIRM_YES = {
  isStdinTTY: true,
  hasControllingTerminal: () => false,
  promptLine: () => Promise.resolve("y"),
};

describe("gcgp.4: an unpaired machine is not a silent one", () => {
  it("a real unpaired session queues nothing, says so, and `doctor` shows what it cost", async () => {
    sink = await StubEventSink.start(); // ONLINE for the whole test
    const sinkUrl = sink.url;
    sandbox = createSandbox();

    // Real install, so this is a faithful "hooks are wired up but the machine isn't paired".
    await runCli(["agent", "install", "claude"], {
      commands: [createAgentCommand({ adapters: [detectedClaude], tokenOptions: FILE_ONLY })],
      stdout: capture().writer,
      stderr: capture().writer,
      ensureConfig: false,
    });

    const err = capture();
    for (const payload of claudeSession("sess-1", sandbox.path("repo"))) {
      const code = await runCli(["hook", "claude"], {
        commands: [
          createHookCommand({
            createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
            readStdin: () => Promise.resolve(payload),
          }),
        ],
        stdout: capture().writer,
        stderr: err.writer,
        ensureConfig: false,
      });
      expect(code).toBe(EXIT.OK); // a hook fire never errors the harness, paired or not
    }

    // (1) Nothing left the machine, and nothing was parked to ambush a future pairing.
    expect(sink.received()).toHaveLength(0);
    expect(new LocalEventQueue().size()).toBe(0);
    // (2) The hot path said so on stderr — the channel a harness log actually keeps.
    expect(err.text()).toContain("not paired");
    // (3) …and left a durable record, because nobody reads a hook's stderr.
    expect(readUnpairedNotice()?.count).toBeGreaterThanOrEqual(2);
    expect(readUnpairedNotice()?.harnesses).toContain("claude_code");

    // (4) `doctor` — where the user goes when beeps don't arrive — reports it as a FAILURE,
    // above the per-adapter checks, with the count and the window.
    const out = capture();
    const doctorCode = await runCli(["doctor"], {
      commands: [
        createDoctorCommand({
          adapters: [],
          tokenOptions: FILE_ONLY,
          createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
          probeNetwork: () => Promise.resolve(true),
        }),
      ],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(doctorCode).toBe(EXIT.ERROR);
    expect(out.text()).toContain("Events lost while unpaired");
    expect(out.text()).toMatch(/event\(s\).*were NOT sent/);
    expect(out.text()).toContain("birdybeep pair");
  });

  it("`test` on an unpaired ONLINE machine names the real cause", async () => {
    sink = await StubEventSink.start();
    const sinkUrl = sink.url;
    sandbox = createSandbox();
    const out = capture();
    const code = await runCli(["test"], {
      commands: [
        createTestCommand({
          createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
          tokenOptions: FILE_ONLY,
        }),
      ],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(out.text()).toContain("NOT PAIRED");
    expect(out.text()).not.toContain("Offline");
    expect(code).toBe(EXIT.ERROR);
    expect(sink.received()).toHaveLength(0);
  });

  /**
   * The measured storm: a copy of a real 1138-entry backlog flushed 1148 POSTs across 23 drain
   * waves. Five (integration, session, eventType) groups in it exceeded the backend's
   * STORM_THRESHOLD of 10, and the summariser that turns those into a push runs BEFORE the
   * notify decision — so even non-notifying types would have beeped the user's phone.
   */
  it("pairing a machine holding a large stale backlog POSTs nothing", async () => {
    sink = await StubEventSink.start();
    const sinkUrl = sink.url;
    sandbox = createSandbox();

    // A backlog shaped like the real one: one session, far past the storm threshold.
    const queue = new LocalEventQueue();
    for (let i = 0; i < 300; i++) {
      queue.enqueue(
        normalizeEvent({
          event_type: "tool_finished",
          status: "running",
          harness: "claude_code",
          source_session_id: "stale-session",
          machine: { label: "box", os: "darwin" },
          workspace: { cwd: sandbox.path("repo") },
          title: `tool ${i}`,
          body: "done",
        }),
      );
    }
    expect(queue.size()).toBe(300);

    const paired = await runCli(["pair"], {
      commands: [
        createPairCommand({
          setup: false,
          fetchImpl: stubPairing(),
          tokenOptions: FILE_ONLY,
          sleep: () => Promise.resolve(),
          ...CONFIRM_YES,
        }),
      ],
      stdout: capture().writer,
      stderr: capture().writer,
      ensureConfig: false,
    });
    expect(paired).toBe(EXIT.OK);
    expect(new LocalEventQueue().size()).toBe(0); // the cold-start guard emptied it

    // Now drain as hard as the CLI ever does. Nothing reaches the wire, so nothing can
    // storm — including the backend's "muted a noisy agent" summary, which needs POSTs to fire.
    for (let i = 0; i < 10; i++) {
      await runCli(["status", "--json"], {
        commands: [
          createStatusCommand({
            adapters: [],
            createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
            tokenOptions: FILE_ONLY,
          }),
        ],
        stdout: capture().writer,
        stderr: capture().writer,
        ensureConfig: false,
      });
    }
    expect(sink.received()).toHaveLength(0);
  }, 30_000); // 300 queue writes + a full drain; ~1.2s on macOS but >5s on Windows CI, where
  // the filesystem is roughly 6x slower. The default 5s cut it off mid-run (gcgp.4's own gate).

  it("events queued AFTER pairing still deliver — the guard is a one-shot, not a mute", async () => {
    sink = await StubEventSink.start();
    const sinkUrl = sink.url;
    sandbox = createSandbox();

    new LocalEventQueue().enqueue(
      normalizeEvent({
        event_type: "agent_completed",
        status: "completed",
        harness: "claude_code",
        source_session_id: "pre-pairing",
        machine: { label: "box", os: "darwin" },
        workspace: { cwd: sandbox.path("repo") },
        title: "stale",
        body: "old",
      }),
    );

    await runCli(["pair"], {
      commands: [
        createPairCommand({
          setup: false,
          fetchImpl: stubPairing(),
          tokenOptions: FILE_ONLY,
          sleep: () => Promise.resolve(),
          ...CONFIRM_YES,
        }),
      ],
      stdout: capture().writer,
      stderr: capture().writer,
      ensureConfig: false,
    });

    // An ordinary offline retry, enqueued after the token exists.
    new LocalEventQueue().enqueue(
      normalizeEvent({
        event_type: "agent_completed",
        status: "completed",
        harness: "claude_code",
        source_session_id: "post-pairing",
        machine: { label: "box", os: "darwin" },
        workspace: { cwd: sandbox.path("repo") },
        title: "fresh",
        body: "new",
      }),
    );

    await runCli(["status", "--json"], {
      commands: [
        createStatusCommand({
          adapters: [],
          createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
          tokenOptions: FILE_ONLY,
        }),
      ],
      stdout: capture().writer,
      stderr: capture().writer,
      ensureConfig: false,
    });

    const delivered = sink.received();
    expect(delivered).toHaveLength(1);
    expect((delivered[0]!.body as { source_session_id: string }).source_session_id).toBe(
      "post-pairing",
    );
  });
});
