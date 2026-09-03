/**
 * `birdybeep hook` proof (CLI-E2E + CLI-OFFLINE-QUEUE-E2E core, hermetic temp HOME):
 * real captured payloads for each harness run through the hook command's pipeline to the
 * stub sink with the correct normalized event + hashed paths; offline → the event lands in
 * the temp-HOME queue and the command returns fast; a later invocation drains + delivers;
 * the full dispatch (hook <harness> [argv-payload | stdin]) routes correctly and exits 0 for
 * every normal outcome; unknown harness → USAGE; and every way a fire can send NOTHING —
 * absent/empty/unparseable/timed-out payload, or a payload the handling adapter doesn't
 * recognize — says so on stderr and exits non-zero (gcgp.1 + gcgp.14).
 */
import { randomUUID } from "node:crypto";

import {
  createSender,
  type Sender,
  setToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import type { CopilotHookEventName } from "@birdybeep/copilot";
import {
  assertNoAbsolutePaths,
  assertPathsHashed,
  createSandbox,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { EXIT } from "../framework";
import {
  createHookCommand,
  type HarnessName,
  HOOK_HARNESSES,
  isHarnessName,
  LEGACY_HOOK_RUNTIME_BUDGET_MS,
  readHookPayload,
  runHookCommand,
} from "./hook";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };
const RAW_CWD = "/Users/dev/code/secret-project";

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

// Real-shaped payloads (one notifying event per harness) + the expected §10.1 type.
const PAYLOADS: {
  harness: HarnessName;
  payload: unknown;
  eventType: string;
  copilotEventName?: CopilotHookEventName;
}[] = [
  {
    harness: "claude",
    payload: {
      hook_event_name: "PermissionRequest",
      session_id: "sess-c",
      cwd: RAW_CWD,
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
    },
    eventType: "approval_required",
  },
  {
    harness: "codex",
    payload: {
      hook_event_name: "PermissionRequest",
      session_id: "sess-x",
      cwd: RAW_CWD,
      tool_name: "Bash",
      tool_input: { command: "rm -rf /Users/dev/secret" },
    },
    eventType: "approval_required",
  },
  {
    harness: "opencode",
    payload: { type: "session.idle", properties: { sessionID: "sess-o" }, cwd: RAW_CWD },
    eventType: "agent_idle",
  },
  {
    // Cursor: sessionEnd(completed) → agent_completed. Carries PII (user_email / transcript_path)
    // that MUST be dropped — assertNoAbsolutePaths below catches any leaked raw path.
    harness: "cursor",
    payload: {
      hook_event_name: "sessionEnd",
      session_id: "sess-cur",
      workspace_roots: [RAW_CWD],
      final_status: "completed",
      user_email: "leak@example.com",
      transcript_path: "/Users/dev/.cursor/transcripts/x.jsonl",
    },
    eventType: "agent_completed",
  },
  {
    // Copilot payloads have no event discriminator: the config passes the name separately.
    // sessionStart (not preToolUse): this table is the "every harness DELIVERS" matrix, and
    // Copilot's tool_* events are withheld client-side (gcgp.3) — covered separately below.
    harness: "copilot",
    copilotEventName: "sessionStart",
    payload: {
      sessionId: "sess-copilot",
      timestamp: 1786075958198,
      cwd: RAW_CWD,
      source: "new",
      initialPrompt: "PRIVATE INITIAL PROMPT",
    },
    eventType: "session_started",
  },
];

/** A Copilot payload whose normalized type the backend can never push (gcgp.3). */
const COPILOT_FILTERED_PAYLOAD = {
  sessionId: "sess-copilot",
  timestamp: 1786075958198,
  cwd: RAW_CWD,
  toolName: "bash",
  toolArgs: '{"command":"cat /Users/dev/private"}',
};

describe("runHookCommand delivers the right normalized event per harness", () => {
  for (const { harness, payload, eventType, copilotEventName } of PAYLOADS) {
    it(`${harness} → ${eventType}, paths hashed, delivered fast`, async () => {
      sink = await StubEventSink.start();
      sandbox = createSandbox();
      const sb = sandbox;
      await setToken(TOKEN, FILE_ONLY);
      const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });

      const start = Date.now();
      const result = await runHookCommand(harness, payload, sender, copilotEventName);
      const elapsed = Date.now() - start;

      expect(result.outcome).toBe("delivered");
      expect(sink.received()).toHaveLength(1);
      const delivered = sink.received()[0]!;
      expect((delivered.body as { event_type: string }).event_type).toBe(eventType);
      assertPathsHashed(delivered, [RAW_CWD, sb.home, sb.realHome]);
      assertNoAbsolutePaths(delivered);
      expect(elapsed).toBeLessThan(5000); // fast return — must not slow the harness
    });
  }

  // gcgp.3 — the other half of the matrix: a real payload whose type can never beep runs the
  // whole pipeline, returns `filtered`, and sends NOTHING.
  it("copilot preToolUse → tool_started is filtered: nothing reaches the backend", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });

    const result = await runHookCommand("copilot", COPILOT_FILTERED_PAYLOAD, sender, "preToolUse");

    expect(result.outcome).toBe("filtered");
    expect(result.eventType).toBe("tool_started");
    expect(sink.received()).toHaveLength(0);
  });
});

describe("offline → queue → drain (CLI-OFFLINE-QUEUE-E2E core)", () => {
  it("queues fast when the backend is unreachable, then a later send drains it", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);

    const offline = createSender({
      baseUrl: sink.url,
      tokenOptions: FILE_ONLY,
      fetchImpl: () => Promise.reject(new Error("offline")),
    });
    const start = Date.now();
    const queued = await runHookCommand("codex", PAYLOADS[1]!.payload, offline);
    expect(queued.outcome).toBe("queued"); // best-effort: parked in the local queue
    expect(Date.now() - start).toBeLessThan(5000); // fast even offline
    expect(sink.received()).toHaveLength(0);

    const online = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });
    const drain = await online.drainNow();
    expect(drain.delivered).toBe(1);
    expect(sink.received()).toHaveLength(1);
  });
});

describe("hook command dispatch (full CLI path)", () => {
  it("shrinks the sender budget to finish inside legacy 10s hook deadlines", async () => {
    sandbox = createSandbox();
    let clock = 0;
    let receivedBudget: number | undefined;
    const sender: Sender = {
      send: () => Promise.resolve({ outcome: "delivered", status: 202 }),
      drainNow: () => Promise.resolve({ delivered: 0, dropped: 0, kept: 0, pruned: 0 }),
    };
    const cmd = createHookCommand({
      createSender: (_baseUrl, budgetMs) => {
        receivedBudget = budgetMs;
        return sender;
      },
      readStdin: () => {
        clock = 2500;
        return Promise.resolve(JSON.stringify(PAYLOADS[0]!.payload));
      },
      now: () => clock,
    });
    const out = capture();

    const code = await runCli(["hook", "claude", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    expect(receivedBudget).toBe(LEGACY_HOOK_RUNTIME_BUDGET_MS - 2500);
    expect(JSON.parse(out.text())).toMatchObject({ harness: "claude", outcome: "delivered" });
  });

  it("delivers via stdin payload and emits the outcome under --json", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      readStdin: () => Promise.resolve(JSON.stringify(PAYLOADS[0]!.payload)),
    });
    const out = capture();
    const code = await runCli(["hook", "claude", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toMatchObject({ harness: "claude", outcome: "delivered" });
    expect(sink.received()).toHaveLength(1);
  });

  it("includes the sender's queue cause under --json (www)", async () => {
    const sender: Sender = {
      send: () =>
        Promise.resolve({ outcome: "queued", queueCause: "backend", status: 503 as const }),
      drainNow: () => Promise.resolve({ delivered: 0, dropped: 0, kept: 0, pruned: 0 }),
    };
    const cmd = createHookCommand({
      createSender: () => sender,
      readStdin: () => Promise.resolve(JSON.stringify(PAYLOADS[0]!.payload)),
    });
    const out = capture();

    const code = await runCli(["hook", "claude", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toMatchObject({
      harness: "claude",
      outcome: "queued",
      queueCause: "backend",
      status: 503,
    });
  });

  // birdybeep-agent-fuf: a Codex NOTIFY fire (payload as the trailing argv arg) now re-launches
  // the send DETACHED so it outlives `codex exec` reaping the notify process group. The notify
  // process itself returns fast with outcome "detached" and delivers NOTHING in-line — the
  // detached worker (a separate `birdybeep hook codex` reading stdin) does the actual send.
  it("codex notify (trailing argv) detaches the send and returns fast, delivering nothing in-line", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    const detached: string[] = [];
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      detachCodexNotify: (payload) => {
        detached.push(payload); // stand in for the real detached worker (no process spawned)
        return true;
      },
    });
    const notify = JSON.stringify({ type: "agent-turn-complete", "thread-id": "t1", cwd: RAW_CWD });
    const out = capture();
    const start = Date.now();
    const code = await runCli(["hook", "codex", notify, "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toMatchObject({ harness: "codex", outcome: "detached" });
    expect(detached).toEqual([notify]); // the exact notify payload was handed to the worker
    expect(sink.received()).toHaveLength(0); // the notify process itself sends nothing in-line
    expect(Date.now() - start).toBeLessThan(2000); // returns fast — never blocks `codex exec`
  });

  // Fallback: when the detached worker can't be launched (e.g. `birdybeep` not on PATH), the
  // notify send happens IN-LINE — a possibly-truncated best-effort delivery beats dropping it.
  it("codex notify falls back to an in-line send when the worker can't be detached", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      detachCodexNotify: () => false, // simulate an un-resolvable `birdybeep` → in-line fallback
    });
    const notify = JSON.stringify({ type: "agent-turn-complete", "thread-id": "t1", cwd: RAW_CWD });
    const out = capture();
    const code = await runCli(["hook", "codex", notify, "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toMatchObject({ harness: "codex", outcome: "delivered" });
    expect(sink.received()).toHaveLength(1); // delivered in-line by the notify process itself
  });

  // Scope guard: only the codex NOTIFY (argv) path detaches. Codex lifecycle hooks arrive on
  // STDIN (fire mid-session, not at exit) and must send in-line, never re-launching a worker.
  it("codex lifecycle hook (stdin payload) sends in-line and never detaches", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    let detachCalls = 0;
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      readStdin: () => Promise.resolve(JSON.stringify(PAYLOADS[1]!.payload)),
      detachCodexNotify: () => {
        detachCalls += 1;
        return true;
      },
    });
    const out = capture();
    const code = await runCli(["hook", "codex", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(detachCalls).toBe(0); // no trailing argv → not a notify → never detached
    expect(JSON.parse(out.text())).toMatchObject({ harness: "codex", outcome: "delivered" });
    expect(sink.received()).toHaveLength(1);
  });

  // Scope guard: detachment is codex-only. A non-codex harness with a trailing argv payload
  // (an unusual invocation shape) must NOT be routed through the codex-notify detach path.
  it("a non-codex harness with a trailing argv payload never detaches", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    let detachCalls = 0;
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      detachCodexNotify: () => {
        detachCalls += 1;
        return true;
      },
    });
    const payload = JSON.stringify(PAYLOADS[0]!.payload); // a claude PermissionRequest
    const out = capture();
    const code = await runCli(["hook", "claude", payload, "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(detachCalls).toBe(0); // detach is scoped to codex notify only
    expect(JSON.parse(out.text())).toMatchObject({ harness: "claude", outcome: "delivered" });
    expect(sink.received()).toHaveLength(1);
  });

  it("delivers Copilot stdin with the separate event-name argument", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    const copilot = PAYLOADS.find((item) => item.harness === "copilot")!;
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      readStdin: () => Promise.resolve(JSON.stringify(copilot.payload)),
    });
    const out = capture();
    const code = await runCli(["hook", "copilot", "sessionStart", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toMatchObject({
      harness: "copilot",
      event: "sessionStart",
      outcome: "delivered",
      eventType: "session_started",
    });
    expect(sink.received()).toHaveLength(1);
  });

  // gcgp.3 — through the FULL CLI dispatch (argv → stdin → adapter → pipeline): a filtered
  // event reports itself in --json and still exits 0, so the harness never sees an error.
  it("reports a filtered Copilot event in --json, sends nothing, and exits 0", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      readStdin: () => Promise.resolve(JSON.stringify(COPILOT_FILTERED_PAYLOAD)),
    });
    const out = capture();
    const code = await runCli(["hook", "copilot", "preToolUse", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toMatchObject({
      harness: "copilot",
      event: "preToolUse",
      outcome: "filtered",
      eventType: "tool_started",
    });
    expect(sink.received()).toHaveLength(0);
  });

  it("unknown harness → USAGE", async () => {
    const cmd = createHookCommand({ readStdin: () => Promise.resolve("{}") });
    const out = capture();
    const code = await runCli(["hook", "bogus"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.USAGE);
    expect(out.text()).toContain("expected one of claude|codex|opencode|cursor|copilot");
  });

  // UPDATED for birdybeep-agent-gcgp.14. This test previously asserted `EXIT.OK`: a stdin
  // timeout was a silent exit 0, which is the failure mode that hid the Cursor-bridge drop —
  // and the 3s cap fires exactly when a loaded machine is slow to flush the pipe, so the event
  // is REAL and LOST. The invariant this test exists to protect is the FAST RETURN, and that
  // is unchanged and still asserted; only the silence is gone.
  it("returns fast when stdin hangs — never blocks the harness — and says the read timed out", async () => {
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1" }),
      readStdin: () => new Promise<string>(() => undefined), // hung stdin: never resolves
      stdinTimeoutMs: 50,
    });
    const out = capture();
    const err = capture();
    const start = Date.now();
    const code = await runCli(["hook", "claude", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
    });
    expect(Date.now() - start).toBeLessThan(2000); // bounded by the 50ms stdin timeout
    expect(code).toBe(EXIT.ERROR); // was EXIT.OK — a timed-out read dropped the event in silence
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "skipped", reason: "stdin-timeout" });
    expect(err.text()).toContain("timed out after 50ms");
    expect(err.text()).toContain("Nothing was sent");
  });

  // UPDATED for birdybeep-agent-gcgp.14. Previously "garbled payload → skipped + exit 0 (never
  // errors the harness)". The old title conflated two things: a hook must never THROW into the
  // harness (still true — this returns an exit code, it does not crash), and it must never
  // report a failure (false: a payload we cannot parse is a dropped event, and gcgp.1 already
  // settled that a drop exits non-zero with a stderr line the harness logs).
  it("unparseable payload → a stderr line naming the size, and a non-zero exit", async () => {
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1" }),
      readStdin: () => Promise.resolve("not json {{"),
    });
    const out = capture();
    const err = capture();
    const code = await runCli(["hook", "claude", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR); // was EXIT.OK
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "skipped", reason: "invalid-json" });
    expect(err.text()).toContain("the 11-byte payload is not valid JSON");
    // The payload is never echoed — it holds prompts, commands and tool output.
    expect(err.text()).not.toContain("not json {{");
  });
});

/**
 * birdybeep-agent-gcgp.14 (1) — an empty, absent, unparseable or timed-out payload was
 * `skipped` at exit 0 with NO output whatsoever: a hook that fires, does nothing, and says
 * nothing. Every branch now names itself, and none of them echoes the payload.
 */
describe("a fire that sends nothing is never silent (gcgp.14)", () => {
  async function fireRaw(
    argv: string[],
    stdin: string,
  ): Promise<{ code: number; text: string; err: string }> {
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1" }),
      readStdin: () => Promise.resolve(stdin),
    });
    const out = capture();
    const err = capture();
    const code = await runCli([...argv, "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
    });
    return { code, text: out.text(), err: err.text() };
  }

  for (const harness of HOOK_HARNESSES) {
    // Copilot takes its event name from argv; every harness reads the payload from stdin.
    const argv = harness === "copilot" ? ["hook", harness, "sessionStart"] : ["hook", harness];

    it(`${harness}: an empty payload is reported, not dropped in silence`, async () => {
      const { code, text, err } = await fireRaw(argv, "");
      expect(code).toBe(EXIT.ERROR);
      expect(JSON.parse(text)).toMatchObject({ outcome: "skipped", reason: "empty-payload" });
      expect(err).toContain(`birdybeep hook ${harness}: the payload was empty`);
    });

    it(`${harness}: a whitespace-only payload is the same drop`, async () => {
      const { code, text } = await fireRaw(argv, "\n  \n");
      expect(code).toBe(EXIT.ERROR);
      expect(JSON.parse(text)).toMatchObject({ reason: "empty-payload" });
    });
  }

  it("a JSON payload that is not an object is a drop, not a fabricated event", async () => {
    const { code, err } = await fireRaw(["hook", "claude"], "null");
    expect(code).toBe(EXIT.ERROR);
    expect(err).toContain("is not a claude hook event");
  });

  it("codex notify with an EMPTY argv payload is reported (it never reaches a worker)", async () => {
    let detachCalls = 0;
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1" }),
      readStdin: () => Promise.resolve(""),
      detachCodexNotify: () => {
        detachCalls += 1;
        return true;
      },
    });
    const out = capture();
    const err = capture();
    const code = await runCli(["hook", "codex", "", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
    });
    expect(detachCalls).toBe(0); // an empty arg is not a notify payload — no worker spawned
    expect(code).toBe(EXIT.ERROR);
    expect(JSON.parse(out.text())).toMatchObject({ reason: "empty-payload" });
  });

  it("copilot without a usable event name is a USAGE error, not a silent skip", async () => {
    const { code, err } = await fireRaw(["hook", "copilot", "bogusEvent"], "{}");
    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain("must be a Copilot hook event name");
    expect(err).toContain("bogusEvent");
  });

  it("copilot with NO second argument is a USAGE error too", async () => {
    const { code, err } = await fireRaw(["hook", "copilot"], "{}");
    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain("(none)");
  });
});

/**
 * birdybeep-agent-gcgp.1 — Cursor desktop's Claude Code compatibility bridge reads
 * `~/.claude/settings.json` and runs `birdybeep hook claude` with a CURSOR payload. Both
 * payloads below are the ones captured verbatim from Cursor 3.14.27's own hook log (redacted
 * for PII/paths; canonical copies live in `packages/cursor/src/__fixtures__/bridge-claude-*.json`),
 * where each produced `exit code: 0` and delivered nothing.
 */
const BRIDGE_SESSION_START = {
  conversation_id: "00000000-0000-4000-8000-000000000002",
  generation_id: "",
  model: "cursor-grok-4.5-high-fast",
  model_id: "grok-4.5",
  model_params: [
    { id: "effort", value: "high" },
    { id: "fast", value: "true" },
  ],
  is_background_agent: false,
  composer_mode: "agent",
  session_id: "00000000-0000-4000-8000-000000000002",
  hook_event_name: "sessionStart",
  cursor_version: "3.14.27",
  workspace_roots: [RAW_CWD],
  user_email: "leak@example.com",
  transcript_path: null,
};
const BRIDGE_STOP = {
  ...BRIDGE_SESSION_START,
  generation_id: "00000000-0000-4000-8000-000000000003",
  status: "completed",
  loop_count: 0,
  input_tokens: 22448,
  output_tokens: 41,
  hook_event_name: "stop",
  transcript_path: "/Users/dev/.cursor/transcripts/x.jsonl",
};

describe("Cursor's Claude bridge (gcgp.1): `hook claude` fed a Cursor payload", () => {
  async function fire(payload: unknown): Promise<{ code: number; text: string; err: string }> {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      readStdin: () => Promise.resolve(JSON.stringify(payload)),
    });
    const out = capture();
    const err = capture();
    const code = await runCli(["hook", "claude", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
    });
    return { code, text: out.text(), err: err.text() };
  }

  for (const [name, payload, eventType] of [
    ["sessionStart", BRIDGE_SESSION_START, "session_started"],
    ["stop", BRIDGE_STOP, "agent_completed"],
  ] as const) {
    it(`delivers the bridged ${name} as a cursor event instead of dropping it`, async () => {
      const { code, text, err } = await fire(payload);
      expect(code).toBe(EXIT.OK);
      expect(JSON.parse(text)).toMatchObject({
        harness: "cursor", // attributed honestly — never masquerading as claude_code
        routedFrom: "claude",
        outcome: "delivered",
        eventType,
      });
      expect(err).toBe("");
      expect(sink!.received()).toHaveLength(1); // the regression: this used to be 0
      const delivered = sink!.received()[0]!;
      expect((delivered.body as { harness: string }).harness).toBe("cursor");
      // Cursor's privacy invariants still hold on the bridged path.
      assertPathsHashed(delivered, [RAW_CWD, sandbox!.home, sandbox!.realHome]);
      assertNoAbsolutePaths(delivered);
      expect(JSON.stringify(delivered.body)).not.toContain("leak@example.com");
    });
  }

  it("a payload no adapter recognizes fails LOUDLY instead of exiting 0 in silence", async () => {
    const { code, text, err } = await fire({ hook_event_name: "someFutureStep", cwd: RAW_CWD });
    expect(code).toBe(EXIT.ERROR); // non-zero: harnesses log this; silence is what hid gcgp.1
    expect(JSON.parse(text)).toMatchObject({ harness: "claude", outcome: "skipped" });
    expect(err).toContain("someFutureStep");
    expect(err).toContain("not a claude hook event");
    expect(sink!.received()).toHaveLength(0);
  });

  it("a real Claude Code event we don't map stays a quiet skip (exit 0, no noise)", async () => {
    const { code, text, err } = await fire({
      hook_event_name: "PreCompact",
      session_id: "sess-c",
      cwd: RAW_CWD,
      trigger: "auto",
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(text)).toMatchObject({ harness: "claude", outcome: "skipped" });
    expect(err).toBe("");
    expect(sink!.received()).toHaveLength(0);
  });

  // birdybeep-agent-gcgp.12: the loud path must fire for FOREIGN payloads only. SPEC §5 defers
  // TaskCreated/TaskCompleted — real Claude Code events whose §10.1 targets don't exist yet —
  // so wiring one has to stay a silent exit 0, while Cursor's lowercase shape (the payload that
  // actually is from another tool) still routes or fails loudly. Both halves, side by side.
  for (const name of ["TaskCreated", "TaskCompleted"]) {
    it(`a deferred-but-real event (${name}) is a quiet exit 0, never a per-fire error`, async () => {
      const { code, text, err } = await fire({
        hook_event_name: name,
        session_id: "sess-c",
        cwd: RAW_CWD,
      });
      expect(code).toBe(EXIT.OK);
      expect(JSON.parse(text)).toMatchObject({ harness: "claude", outcome: "skipped" });
      expect(err).toBe(""); // the defect: this used to be an error line on EVERY fire
      expect(sink!.received()).toHaveLength(0); // still unmapped — quiet, not invented
    });
  }

  it("SubagentStart is Codex's, not Claude Code's, so it still fails loudly", async () => {
    const { code, err } = await fire({
      hook_event_name: "SubagentStart",
      session_id: "sess-c",
      cwd: RAW_CWD,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(err).toContain("SubagentStart");
    expect(sink!.received()).toHaveLength(0);
  });
});

/**
 * birdybeep-agent-gcgp.14 (2) — before this, `recognizesPayload` answered only for claude and
 * cursor: codex, opencode and copilot returned `true` unconditionally, so a foreign payload at
 * those hooks skipped quietly at exit 0. Copilot was worse than quiet — its payloads carry no
 * event discriminator, so a foreign one normalized into a FABRICATED Copilot event and was
 * SENT (reproduced: a real Cursor sessionStart piped into `hook copilot sessionStart`
 * delivered a `session_started`).
 *
 * The intruder below is the real captured Cursor 3.14.27 payload — the one payload we KNOW
 * travels to the wrong hook command, because Cursor's own Claude bridge sends it there.
 */
describe("every harness recognizes a foreign payload (gcgp.14)", () => {
  const FOREIGN = BRIDGE_SESSION_START; // a real Cursor payload, captured from Cursor's hook log

  async function fireForeign(
    argv: string[],
    payload: unknown,
  ): Promise<{ code: number; text: string; err: string }> {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      readStdin: () => Promise.resolve(JSON.stringify(payload)),
    });
    const out = capture();
    const err = capture();
    const code = await runCli([...argv, "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
    });
    return { code, text: out.text(), err: err.text() };
  }

  it("codex: a foreign payload fails loudly and sends nothing", async () => {
    const { code, err } = await fireForeign(["hook", "codex"], FOREIGN);
    expect(code).toBe(EXIT.ERROR);
    expect(err).toContain("is not a codex hook event");
    expect(err).toContain("sessionStart");
    expect(sink!.received()).toHaveLength(0);
  });

  it("codex: a third-party program chained into the notify slot fails loudly", async () => {
    // The live risk: `notify` is a single-valued scalar other tools claim, and a chain that
    // forwards to `birdybeep hook codex` can hand us any shape at all.
    const { code, err } = await fireForeign(["hook", "codex"], {
      type: "task.finished",
      payload: { ok: true },
    });
    expect(code).toBe(EXIT.ERROR);
    expect(err).toContain('type "task.finished"');
    expect(sink!.received()).toHaveLength(0);
  });

  it("opencode: a foreign payload fails loudly and sends nothing", async () => {
    const { code, err } = await fireForeign(["hook", "opencode"], FOREIGN);
    expect(code).toBe(EXIT.ERROR);
    expect(err).toContain("is not an opencode hook event");
    expect(sink!.received()).toHaveLength(0);
  });

  it("copilot: a foreign payload is REFUSED instead of becoming a fabricated event", async () => {
    const { code, text, err } = await fireForeign(["hook", "copilot", "sessionStart"], FOREIGN);
    expect(code).toBe(EXIT.ERROR);
    expect(err).toContain("is not a copilot hook event");
    // The regression: this used to deliver a Copilot session_started built from a Cursor payload.
    expect(sink!.received()).toHaveLength(0);
    expect(JSON.parse(text)).toMatchObject({
      harness: "copilot",
      outcome: "skipped",
      reason: "foreign-payload",
    });
  });

  // The recognizers must not become a wall: every real payload still delivers at its own hook.
  // One sink for all five (distinct harnesses → distinct dedup identities → five deliveries).
  it("every harness's own real payload still delivers through the same gate", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;

    for (const { harness, payload, eventType, copilotEventName } of PAYLOADS) {
      const cmd = createHookCommand({
        createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
        readStdin: () => Promise.resolve(JSON.stringify(payload)),
      });
      const argv =
        copilotEventName !== undefined ? ["hook", harness, copilotEventName] : ["hook", harness];
      const out = capture();
      const err = capture();
      const code = await runCli([...argv, "--json"], {
        commands: [cmd],
        stdout: out.writer,
        stderr: err.writer,
        ensureConfig: false,
      });
      expect(code, harness).toBe(EXIT.OK);
      expect(JSON.parse(out.text()), harness).toMatchObject({ outcome: "delivered", eventType });
      expect(err.text(), harness).toBe("");
    }
    expect(sink.received()).toHaveLength(PAYLOADS.length);
  });
});

/**
 * birdybeep-agent-gcgp.17 — the Cursor tool-failure Beep, driven through the FULL CLI dispatch
 * (argv → stdin → adapter → pipeline → sink). Payload is the canonical fixture
 * `packages/cursor/src/__fixtures__/postToolUseFailure.json`, whose field set is Cursor's own
 * `agent.v1.PostToolUseFailureRequestQuery` schema.
 */
describe("Cursor postToolUseFailure through the CLI (gcgp.17)", () => {
  const FAILURE = {
    conversation_id: "00000000-0000-4000-8000-000000000002",
    generation_id: "00000000-0000-4000-8000-000000000003",
    session_id: "00000000-0000-4000-8000-000000000002",
    hook_event_name: "postToolUseFailure",
    cursor_version: "3.14.27",
    workspace_roots: [RAW_CWD],
    user_email: "leak@example.com",
    transcript_path: "/Users/dev/.cursor/transcripts/x.jsonl",
    tool_name: "Bash",
    tool_input: '{"command":"psql postgres://user:sbp_TESTONLY_secret@db/app"}',
    error_message: "FATAL: password authentication failed (/Users/dev/code/secret-project/.env)",
    failure_type: "tool_error",
    duration_ms: 1843,
    is_interrupt: false,
  };

  async function fire(payload: unknown): Promise<{ code: number; text: string; err: string }> {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      readStdin: () => Promise.resolve(JSON.stringify(payload)),
    });
    const out = capture();
    const err = capture();
    const code = await runCli(["hook", "cursor", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
    });
    return { code, text: out.text(), err: err.text() };
  }

  it("delivers agent_failed — the Beep a tool failure has never produced", async () => {
    const { code, text, err } = await fire(FAILURE);
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(text)).toMatchObject({
      harness: "cursor",
      outcome: "delivered", // the regression: this used to be "skipped"
      eventType: "agent_failed",
    });
    expect(err).toBe("");
    expect(sink!.received()).toHaveLength(1);

    const delivered = sink!.received()[0]!;
    assertPathsHashed(delivered, [RAW_CWD, sandbox!.home, sandbox!.realHome]);
    assertNoAbsolutePaths(delivered);
    const all = JSON.stringify(delivered.body);
    expect(all).not.toContain("sbp_TESTONLY_secret"); // a credential in the failing command
    expect(all).not.toContain("password authentication failed");
    expect(all).not.toContain("leak@example.com");
  });

  it("a user interrupt stays a quiet skip — exit 0, nothing sent, no noise", async () => {
    const { code, text, err } = await fire({ ...FAILURE, is_interrupt: true });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(text)).toMatchObject({ harness: "cursor", outcome: "skipped" });
    expect(err).toBe("");
    expect(sink!.received()).toHaveLength(0);
  });

  // De-registered by gcgp.17, but a config an earlier release patched still fires them: they
  // are real Cursor events we simply don't map, so they stay a quiet exit 0.
  it("the de-registered steps stay quiet if an old config still fires them", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;

    for (const name of ["beforeSubmitPrompt", "afterAgentResponse"]) {
      const cmd = createHookCommand({
        createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({
              hook_event_name: name,
              session_id: "sess-cur",
              cursor_version: "3.14.27",
              workspace_roots: [RAW_CWD],
            }),
          ),
      });
      const out = capture();
      const err = capture();
      const code = await runCli(["hook", "cursor", "--json"], {
        commands: [cmd],
        stdout: out.writer,
        stderr: err.writer,
        ensureConfig: false,
      });
      expect(code, name).toBe(EXIT.OK);
      expect(JSON.parse(out.text()), name).toMatchObject({ harness: "cursor", outcome: "skipped" });
      expect(err.text(), name).toBe("");
    }
    expect(sink.received()).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("isHarnessName guards all five harnesses", () => {
    expect(HOOK_HARNESSES).toEqual(["claude", "codex", "opencode", "cursor", "copilot"]);
    expect(isHarnessName("codex")).toBe(true);
    expect(isHarnessName("cursor")).toBe(true);
    expect(isHarnessName("copilot")).toBe(true);
    expect(isHarnessName("bogus")).toBe(false);
    expect(isHarnessName(undefined)).toBe(false);
  });

  it("readHookPayload prefers the trailing arg, else reads stdin", async () => {
    expect(await readHookPayload(["codex", "ARGV"], () => Promise.resolve("STDIN"))).toBe("ARGV");
    expect(await readHookPayload(["claude"], () => Promise.resolve("STDIN"))).toBe("STDIN");
    expect(
      await readHookPayload(["copilot", "preToolUse"], () => Promise.resolve("STDIN"), true),
    ).toBe("STDIN");
  });
});
