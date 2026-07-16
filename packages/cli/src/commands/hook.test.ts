/**
 * `birdybeep hook` proof (CLI-E2E + CLI-OFFLINE-QUEUE-E2E core, hermetic temp HOME):
 * real captured payloads for each harness run through the hook command's pipeline to the
 * stub sink with the correct normalized event + hashed paths; offline → the event lands in
 * the temp-HOME queue and the command returns fast; a later invocation drains + delivers;
 * the full dispatch (hook <harness> [argv-payload | stdin]) routes correctly and always
 * exits 0; unknown harness → USAGE; garbled payload → skipped.
 */
import { randomUUID } from "node:crypto";

import { createSender, setToken, unavailableKeychainBackend } from "@birdybeep/agent-core";
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
const PAYLOADS: { harness: HarnessName; payload: unknown; eventType: string }[] = [
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
];

describe("runHookCommand delivers the right normalized event per harness", () => {
  for (const { harness, payload, eventType } of PAYLOADS) {
    it(`${harness} → ${eventType}, paths hashed, delivered fast`, async () => {
      sink = await StubEventSink.start();
      sandbox = createSandbox();
      const sb = sandbox;
      await setToken(TOKEN, FILE_ONLY);
      const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });

      const start = Date.now();
      const result = await runHookCommand(harness, payload, sender);
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

  it("delivers via the trailing argv payload (Codex notify shape)", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
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
    expect(out.text()).toContain("expected one of claude|codex|opencode|cursor");
  });

  it("returns fast (skipped) when stdin hangs — never blocks the harness", async () => {
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1" }),
      readStdin: () => new Promise<string>(() => undefined), // hung stdin: never resolves
      stdinTimeoutMs: 50,
    });
    const out = capture();
    const start = Date.now();
    const code = await runCli(["hook", "claude", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(Date.now() - start).toBeLessThan(2000); // bounded by the 50ms stdin timeout
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "skipped" });
  });

  it("garbled payload → skipped + exit 0 (never errors the harness)", async () => {
    const cmd = createHookCommand({
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1" }),
      readStdin: () => Promise.resolve("not json {{"),
    });
    const out = capture();
    const code = await runCli(["hook", "claude", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "skipped" });
  });
});

describe("helpers", () => {
  it("isHarnessName guards the four harnesses", () => {
    expect(HOOK_HARNESSES).toEqual(["claude", "codex", "opencode", "cursor"]);
    expect(isHarnessName("codex")).toBe(true);
    expect(isHarnessName("cursor")).toBe(true);
    expect(isHarnessName("bogus")).toBe(false);
    expect(isHarnessName(undefined)).toBe(false);
  });

  it("readHookPayload prefers the trailing arg, else reads stdin", async () => {
    expect(await readHookPayload(["codex", "ARGV"], () => Promise.resolve("STDIN"))).toBe("ARGV");
    expect(await readHookPayload(["claude"], () => Promise.resolve("STDIN"))).toBe("STDIN");
  });
});
