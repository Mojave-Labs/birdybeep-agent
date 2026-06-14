/**
 * CX-E2E — the mandatory real-hook gate. Installs the REAL Codex adapter into a hermetic
 * temp HOME, then fires actual Codex notify + lifecycle-hook payloads through the
 * `birdybeep hook codex` pipeline (runCodexHook = runAgentHook: normalizeEvent → dedup →
 * sender.send, plus the trust-marker write) and asserts, at the stub sink:
 *   - correct §10.1 mapping for every Codex surface (notify→agent_completed,
 *     PermissionRequest→approval_required, PostToolUse→tool_finished, Subagent*→…);
 *   - the one-time TRUST transition: needs_trust before any event → installed after the
 *     first real delivered event (the Codex-specific gate);
 *   - the token resolves from the strict-perm FILE fallback (no keychain), rides as a
 *     Bearer, and never appears in the installed config or the event body;
 *   - absolute paths are hashed, nothing exceeds the cap, and NO user/assistant content
 *     (tool_input, last-assistant-message) is persisted;
 *   - dedup collapses a repeated event to exactly one beep;
 *   - offline: an unreachable backend queues the event + returns fast, draining later;
 *   - the hook returns fast (must not block the harness).
 * Stub sink only — live wrangler-dev / EVT-INGEST delivery is the deferred cross-repo E2E.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  createSender,
  type SendResult,
  setToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import {
  assertNoAbsolutePaths,
  assertNoRawValues,
  assertPathsHashed,
  assertWithinSizeCap,
  createSandbox,
  deliveredBearerToken,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { codexAdapter } from "./adapter";
import { codexConfigFile } from "./paths";
import { runCodexHook } from "./trust";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };

// §10.5 default-notify (the attention events beep; activity updates do not).
const NOTIFY_DEFAULT: Record<string, boolean> = {
  session_started: false,
  approval_required: true,
  tool_finished: false,
  subagent_started: false,
  subagent_completed: false,
  agent_completed: true,
};

const SESSION = "sess_e2e_codex";
const RAW_CWD = "/Users/dev/code/secret-codex-project";
const hookBase = { session_id: SESSION, cwd: RAW_CWD };

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
});

async function setUp(): Promise<{
  sb: Sandbox;
  fire: (p: unknown) => Promise<SendResult["outcome"] | "deduped" | "skipped">;
}> {
  sink = await StubEventSink.start();
  sandbox = createSandbox();
  const sb = sandbox;
  await setToken(TOKEN, FILE_ONLY); // strict-perm file fallback (keychain unavailable)
  const install = await codexAdapter.install();
  expect(install.status).toBe("needs_trust"); // Codex: not "installed" until first event
  const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });
  const fire = async (p: unknown) => (await runCodexHook(p, { sender })).outcome;
  return { sb, fire };
}

describe("CX-E2E: install → fire real notify + hooks → assert delivered", () => {
  it("delivers correctly-normalized events for every Codex surface", async () => {
    const { sb, fire } = await setUp();
    const start = Date.now();
    // Distinct event types → distinct dedup identities → all delivered.
    await fire({ ...hookBase, hook_event_name: "SessionStart", source: "startup", model: "gpt-5" });
    await fire({
      ...hookBase,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
    });
    await fire({
      ...hookBase,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: `${RAW_CWD}/src/x.ts` },
      tool_response: { ok: true },
      tool_use_id: "tu1",
    });
    await fire({
      ...hookBase,
      hook_event_name: "SubagentStart",
      agent_type: "explorer",
      agent_id: "sub1",
    });
    await fire({
      ...hookBase,
      hook_event_name: "SubagentStop",
      agent_type: "explorer",
      agent_id: "sub1",
    });
    await fire({
      type: "agent-turn-complete",
      "thread-id": SESSION,
      "turn-id": "turn1",
      cwd: RAW_CWD,
      client: "codex-tui",
      "input-messages": ["do the thing"],
      "last-assistant-message": "done",
    });
    const elapsed = Date.now() - start;

    const expected: Record<string, string> = {
      session_started: "starting",
      approval_required: "waiting_for_approval",
      tool_finished: "running",
      subagent_started: "running",
      subagent_completed: "running",
      agent_completed: "completed",
    };
    expect(sink!.received()).toHaveLength(Object.keys(expected).length); // all delivered, none dropped

    for (const [eventType, status] of Object.entries(expected)) {
      const delivered = sink!
        .received()
        .find((e) => (e.body as { event_type?: string }).event_type === eventType);
      expect(delivered, `missing ${eventType}`).toBeDefined();
      const body = delivered!.body as Record<string, unknown>;
      expect(body["status"]).toBe(status);
      expect(body["harness"]).toBe("codex");
      // Privacy: paths hashed, no raw absolutes, under cap, token never in body.
      assertPathsHashed(delivered!, [RAW_CWD, sb.home, sb.realHome]);
      assertNoAbsolutePaths(delivered!);
      assertWithinSizeCap(delivered!);
      assertNoRawValues(delivered!, [TOKEN], { scope: "body" });
      // Token came from the strict-perm FILE fallback and rode as a Bearer.
      expect(deliveredBearerToken(delivered!)).toBe(TOKEN);
      // Notify-default is defined per §10.5 (server derives it from event_type).
      expect(NOTIFY_DEFAULT[eventType]).toBeDefined();
    }

    // Headline beeps explicitly present.
    const types = sink!.received().map((e) => (e.body as { event_type: string }).event_type);
    expect(types).toContain("approval_required"); // from PermissionRequest hook
    expect(types).toContain("agent_completed"); // from notify

    expect(elapsed).toBeLessThan(5000); // hook returns fast
    expect(readFileSync(codexConfigFile({ home: sb.home }), "utf8")).not.toContain(TOKEN);
  });

  it("trust transition: needs_trust before any event → installed after the first", async () => {
    const { fire } = await setUp();
    expect(await codexAdapter.status()).toBe("needs_trust"); // installed files, no event yet
    const outcome = await fire({
      ...hookBase,
      hook_event_name: "SessionStart",
      source: "startup",
    });
    expect(outcome).toBe("delivered");
    expect(await codexAdapter.status()).toBe("installed"); // first real event flipped it
  });

  it("never persists user/assistant content (tool_input + last-assistant-message)", async () => {
    const { fire } = await setUp();
    await fire({
      ...hookBase,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "cat /Users/dev/.ssh/id_rsa # sk-abcdefghijklmnop1234" },
    });
    await fire({
      type: "agent-turn-complete",
      "thread-id": SESSION,
      cwd: RAW_CWD,
      "input-messages": ["leak /Users/dev/secret/notes.md"],
      "last-assistant-message": "secret sk-zyxwvutsrqponml9876 at /Users/dev/.aws/credentials",
    });
    const all = JSON.stringify(sink!.received().map((e) => e.body));
    expect(all).not.toContain("sk-abcdefghijklmnop1234");
    expect(all).not.toContain("sk-zyxwvutsrqponml9876");
    expect(all).not.toContain("id_rsa");
    expect(all).not.toContain("credentials");
    expect(all).not.toContain("notes.md");
    // The mapped bodies are the safe fixed strings, not the raw content.
    const approval = sink!
      .received()
      .find((e) => (e.body as { event_type: string }).event_type === "approval_required");
    expect((approval!.body as { body: string }).body).toBe("Approve Bash?");
  });

  it("dedupes a repeated event: two identical notify → exactly ONE agent_completed", async () => {
    const { fire } = await setUp();
    const first = await fire({ type: "agent-turn-complete", "thread-id": SESSION, cwd: RAW_CWD });
    const second = await fire({ type: "agent-turn-complete", "thread-id": SESSION, cwd: RAW_CWD });
    expect(first).toBe("delivered");
    expect(second).toBe("deduped"); // same beep within the window → suppressed
    const completed = sink!
      .received()
      .filter((e) => (e.body as { event_type: string }).event_type === "agent_completed");
    expect(completed).toHaveLength(1);
  });

  it("an unmappable Codex payload is skipped (never delivered, never throws)", async () => {
    const { fire } = await setUp();
    const outcome = await fire({ ...hookBase, hook_event_name: "PreCompact", trigger: "auto" });
    expect(outcome).toBe("skipped");
    expect(sink!.received()).toHaveLength(0);
  });

  it("offline: unreachable backend queues the event + returns fast, draining on a later send", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    await codexAdapter.install();

    // Offline sender: fetch rejects immediately (simulated network failure).
    const offline = createSender({
      baseUrl: sink.url,
      tokenOptions: FILE_ONLY,
      fetchImpl: () => Promise.reject(new Error("offline")),
    });
    const start = Date.now();
    const queued = await runCodexHook(
      { ...hookBase, hook_event_name: "PermissionRequest", tool_name: "Bash" },
      { sender: offline },
    );
    const elapsed = Date.now() - start;
    expect(queued.outcome).toBe("queued"); // not delivered — parked in the local queue
    expect(elapsed).toBeLessThan(5000); // returned fast despite being offline
    expect(sink.received()).toHaveLength(0);

    // A later online send drains the backlog (shared on-disk queue under the temp HOME).
    const online = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });
    const drain = await online.drainNow();
    expect(drain.delivered).toBe(1);
    expect(sink.received()).toHaveLength(1);
    expect((sink.received()[0]!.body as { event_type: string }).event_type).toBe(
      "approval_required",
    );
  });
});
