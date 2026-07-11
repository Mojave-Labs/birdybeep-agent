/**
 * `birdybeep status` proof (hermetic temp HOME): seed the local queue with real failed-
 * earlier hook payloads, run `status` with the stub reachable, and assert the depth before
 * drain, that queued events are POSTed to the stub, the queue empties, the per-integration
 * statuses + machine + pairing state are reported (human + --json), and the not-paired
 * branch exits non-zero. Drain is opportunistic; status never mutates harness config.
 */
import { randomUUID } from "node:crypto";

import {
  type AgentAdapter,
  clearToken,
  createSender,
  type IntegrationStatus,
  setToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import {
  createSandbox,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { EXIT } from "../framework";
import { runHookCommand } from "./hook";
import { createStatusCommand } from "./status";

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

function withStatus(adapter: AgentAdapter, status: IntegrationStatus): AgentAdapter {
  return { ...adapter, status: () => Promise.resolve(status) };
}

/** Park N real events in the local queue by firing hooks while "offline". */
async function seedQueue(): Promise<void> {
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
  await runHookCommand(
    "codex",
    { hook_event_name: "PermissionRequest", session_id: "s", cwd: "/tmp/x", tool_name: "Bash" },
    offline,
  );
}

interface StatusJson {
  machine: { label: string; os: string };
  paired: boolean;
  integrations: { harness: string; status: string }[];
  queue: { depthBefore: number; delivered: number; depthAfter: number };
}

describe("birdybeep status", () => {
  it("drains the queue, reports depth, and shows per-integration status (--json)", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    await seedQueue();
    const sinkUrl = sink.url;

    const cmd = createStatusCommand({
      adapters: [withStatus({ id: "codex", displayName: "Codex" } as AgentAdapter, "needs_trust")],
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    const code = await runCli(["status", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    const json = JSON.parse(out.text()) as StatusJson;
    expect(json.paired).toBe(true);
    expect(json.queue.depthBefore).toBe(2);
    expect(json.queue.delivered).toBe(2);
    expect(json.queue.depthAfter).toBe(0);
    expect(json.integrations[0]).toMatchObject({ harness: "codex", status: "needs_trust" });
    expect(sink.received()).toHaveLength(2); // the queued events were POSTed to the stub
  });

  it("human mode prints machine, pairing, integrations, and queue lines", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const cmd = createStatusCommand({
      adapters: [withStatus({ id: "codex", displayName: "Codex" } as AgentAdapter, "installed")],
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1", tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    await runCli(["status"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    const text = out.text();
    expect(text).toContain("Machine:");
    expect(text).toContain("Paired:  yes");
    expect(text).toContain("Codex: installed");
    expect(text).toContain("Queue:");
  });

  it("not paired → says so clearly and exits non-zero", async () => {
    sandbox = createSandbox();
    await clearToken(FILE_ONLY); // ensure no token
    const cmd = createStatusCommand({
      adapters: [],
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1", tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    const code = await runCli(["status"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(out.text()).toContain("Paired:  no");
  });
});
