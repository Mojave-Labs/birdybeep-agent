/**
 * CLI-OFFLINE-QUEUE-E2E (§9.3, §19.4) — the mandatory offline-reliability gate, fully
 * local. Real install in a temp HOME, then: with the backend unreachable a real hook
 * returns FAST and queues the event (never errors the harness); a later `status` drains
 * the queue and delivers to the stub API; and a hung connection is bounded by the sender
 * timeout. Timing assertions prove the harness is never blocked or slowed.
 */
import { randomUUID } from "node:crypto";

import {
  type AgentAdapter,
  createSender,
  LocalEventQueue,
  setToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import { codexAdapter } from "@birdybeep/codex";
import {
  createSandbox,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./cli";
import { createAgentCommand } from "./commands/agent";
import { createHookCommand } from "./commands/hook";
import { createStatusCommand } from "./commands/status";
import { EXIT } from "./framework";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };
const CODEX_HOOK = JSON.stringify({
  hook_event_name: "PermissionRequest",
  session_id: "s",
  cwd: "/Users/dev/secret",
  tool_name: "Bash",
});

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
const ORIGINAL_CODEX_HOME = process.env["CODEX_HOME"];
beforeEach(() => delete process.env["CODEX_HOME"]);
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
});
afterAll(() => {
  if (ORIGINAL_CODEX_HOME !== undefined) process.env["CODEX_HOME"] = ORIGINAL_CODEX_HOME;
});

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}
function quiet(): {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
} {
  return { stdout: capture().writer, stderr: capture().writer };
}
const detectedCodex: AgentAdapter = {
  ...codexAdapter,
  detect: () => Promise.resolve({ detected: true, version: "test" }),
};

interface StatusJson {
  queue: { depthBefore: number; delivered: number; depthAfter: number };
}

describe("CLI-OFFLINE-QUEUE-E2E", () => {
  it("offline hook → queued + fast (non-blocking); later status drains → delivered", async () => {
    sink = await StubEventSink.start();
    const sinkUrl = sink.url;
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);

    // Real install (faithful scenario).
    await runCli(["agent", "install", "codex"], {
      commands: [createAgentCommand({ adapters: [detectedCodex] })],
      ...quiet(),
      ensureConfig: false,
    });

    // OFFLINE: backend unreachable → the hook must queue + return fast, never error the harness.
    const offlineHook = createHookCommand({
      createSender: () =>
        createSender({
          baseUrl: "http://127.0.0.1:1",
          tokenOptions: FILE_ONLY,
          fetchImpl: () => Promise.reject(new Error("offline")),
        }),
    });
    const out1 = capture();
    const start = Date.now();
    const code1 = await runCli(["hook", "codex", CODEX_HOOK, "--json"], {
      commands: [offlineHook],
      stdout: out1.writer,
      stderr: out1.writer,
      ensureConfig: false,
    });
    const offlineLatency = Date.now() - start;

    expect(code1).toBe(EXIT.OK); // never errors the harness
    expect(JSON.parse(out1.text())).toMatchObject({ outcome: "queued" });
    expect(offlineLatency).toBeLessThan(2000); // fast, non-blocking
    expect(new LocalEventQueue().size()).toBe(1); // parked on disk
    expect(sink.received()).toHaveLength(0); // nothing delivered while offline

    // ONLINE: a later `status` drains the queue and delivers to the API.
    const statusCmd = createStatusCommand({
      adapters: [],
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
    });
    const out2 = capture();
    await runCli(["status", "--json"], {
      commands: [statusCmd],
      stdout: out2.writer,
      stderr: out2.writer,
      ensureConfig: false,
    });
    const sj = JSON.parse(out2.text()) as StatusJson;
    expect(sj.queue.depthBefore).toBe(1);
    expect(sj.queue.delivered).toBe(1);
    expect(sj.queue.depthAfter).toBe(0); // drained
    expect(sink.received()).toHaveLength(1); // delivered to POST /v1/agent-events
  });

  it("a hung connection is bounded by the sender timeout (still fast + queued)", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);

    // A fetch that never resolves on its own — only the sender's AbortController unblocks it.
    const hangingFetch = ((_url: string, opts?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const hangHook = createHookCommand({
      createSender: () =>
        createSender({
          baseUrl: "http://127.0.0.1:1",
          timeoutMs: 100, // short timeout bounds the hang
          tokenOptions: FILE_ONLY,
          fetchImpl: hangingFetch,
        }),
    });
    const out = capture();
    const start = Date.now();
    const code = await runCli(["hook", "codex", CODEX_HOOK, "--json"], {
      commands: [hangHook],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(Date.now() - start).toBeLessThan(1500); // bounded by the 100ms sender timeout
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "queued" });
  });
});
