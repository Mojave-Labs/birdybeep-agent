/**
 * OC-E2E — the mandatory real-plugin gate. Installs the REAL OpenCode adapter into a
 * hermetic temp HOME, LOADS the BirdyBeep plugin module (createBirdyBeepPlugin → the same
 * Hooks OpenCode registers at startup), then fires actual OpenCode lifecycle payloads at
 * those handlers through the hook pipeline (runOpenCodeHook = normalizeEvent → dedup →
 * sender.send + the restart-marker write) and asserts, at the stub sink:
 *   - correct §10.1 mapping for every forwarded surface (session.created→session_started,
 *     permission.updated→approval_required, session.idle→agent_idle, session.error→
 *     agent_failed, tool.execute.before/after→tool_started/tool_finished);
 *   - the needs_restart → installed transition (the OpenCode-specific gate): needs_restart
 *     before any event → installed after the first real delivered event;
 *   - the token resolves from the strict-perm FILE fallback, rides as a Bearer, and never
 *     appears in the installed config or the event body;
 *   - absolute paths are hashed, nothing exceeds the cap, and NO user/assistant content
 *     (permission title, tool args) is persisted;
 *   - dedup collapses a repeated event to one beep;
 *   - offline: an unreachable backend queues the event + returns fast, draining later;
 *   - the hook returns fast (must not block OpenCode).
 * Stub sink only — spawning a REAL `opencode` process + the live wrangler-dev / EVT-INGEST
 * delivery are the deferred cross-repo E2E (no OpenCode binary / product ingestion here).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { createSender, setToken, unavailableKeychainBackend } from "@birdybeep/agent-core";
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

import { opencodeAdapter } from "./adapter";
import { opencodeConfigFile } from "./paths";
import { type BirdyBeepHooks, createBirdyBeepPlugin } from "./plugin";
import { runOpenCodeHook } from "./restart";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };

// §10.5 default-notify (the attention events beep; activity updates do not).
const NOTIFY_DEFAULT: Record<string, boolean> = {
  session_started: false,
  approval_required: true,
  agent_idle: true,
  agent_failed: true,
  tool_started: false,
  tool_finished: false,
};

const SID = "ses_e2e_opencode";
const RAW_CWD = "/Users/dev/code/secret-opencode-project";

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
});

async function setUp(): Promise<{ sb: Sandbox; hooks: BirdyBeepHooks }> {
  sink = await StubEventSink.start();
  sandbox = createSandbox();
  const sb = sandbox;
  await setToken(TOKEN, FILE_ONLY); // strict-perm file fallback (keychain unavailable)
  const install = await opencodeAdapter.install();
  expect(install.status).toBe("needs_restart"); // OpenCode: not "installed" until restart+event
  const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });
  const plugin = createBirdyBeepPlugin({
    invokeHook: async (env) => {
      await runOpenCodeHook(env, { sender });
    },
  });
  const hooks = await plugin({ directory: RAW_CWD });
  return { sb, hooks };
}

describe("OC-E2E: install → load plugin → fire real events → assert delivered", () => {
  it("delivers correctly-normalized events for every forwarded OpenCode surface", async () => {
    const { sb, hooks } = await setUp();
    const start = Date.now();
    await hooks.event({ event: { type: "session.created", properties: { info: { id: SID } } } });
    await hooks.event({
      event: { type: "permission.updated", properties: { sessionID: SID, type: "bash" } },
    });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } });
    await hooks.event({
      event: {
        type: "session.error",
        properties: { sessionID: SID, error: { name: "ProviderAuthError" } },
      },
    });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: SID, callID: "c1" });
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: SID, callID: "c2" });
    const elapsed = Date.now() - start;

    const expected: Record<string, string> = {
      session_started: "starting",
      approval_required: "waiting_for_approval",
      agent_idle: "idle",
      agent_failed: "failed",
      tool_started: "running",
      tool_finished: "running",
    };
    expect(sink!.received()).toHaveLength(Object.keys(expected).length); // all delivered, none dropped

    for (const [eventType, status] of Object.entries(expected)) {
      const delivered = sink!
        .received()
        .find((e) => (e.body as { event_type?: string }).event_type === eventType);
      expect(delivered, `missing ${eventType}`).toBeDefined();
      const body = delivered!.body as Record<string, unknown>;
      expect(body["status"]).toBe(status);
      expect(body["harness"]).toBe("opencode");
      expect(body["source_session_id"]).toBe(SID);
      assertPathsHashed(delivered!, [RAW_CWD, sb.home, sb.realHome]);
      assertNoAbsolutePaths(delivered!);
      assertWithinSizeCap(delivered!);
      assertNoRawValues(delivered!, [TOKEN], { scope: "body" });
      expect(deliveredBearerToken(delivered!)).toBe(TOKEN);
      expect(NOTIFY_DEFAULT[eventType]).toBeDefined();
    }

    // Headline beeps explicitly present.
    const types = sink!.received().map((e) => (e.body as { event_type: string }).event_type);
    expect(types).toContain("approval_required");
    expect(types).toContain("agent_failed");

    expect(elapsed).toBeLessThan(5000); // hook returns fast
    expect(readFileSync(opencodeConfigFile({ home: sb.home }), "utf8")).not.toContain(TOKEN);
  });

  it("restart transition: needs_restart before any event → installed after the first", async () => {
    const { hooks } = await setUp();
    expect(await opencodeAdapter.status()).toBe("needs_restart"); // plugin configured, not loaded yet
    await hooks.event({ event: { type: "session.created", properties: { info: { id: SID } } } });
    expect(await opencodeAdapter.status()).toBe("installed"); // first real event proves the plugin loaded
  });

  it("never persists user content (permission title + tool args)", async () => {
    const { hooks } = await setUp();
    await hooks.event({
      event: {
        type: "permission.updated",
        properties: {
          sessionID: SID,
          type: "bash",
          title: "cat /Users/dev/.ssh/id_rsa # sk-abcd1234efgh5678",
        },
      },
    });
    const all = JSON.stringify(sink!.received().map((e) => e.body));
    expect(all).not.toContain("sk-abcd1234efgh5678");
    expect(all).not.toContain("id_rsa");
    const approval = sink!
      .received()
      .find((e) => (e.body as { event_type: string }).event_type === "approval_required");
    expect((approval!.body as { body: string }).body).toBe("Approval requested");
  });

  it("dedupes a repeated event: two identical session.idle → exactly ONE agent_idle", async () => {
    const { hooks } = await setUp();
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } });
    const idle = sink!
      .received()
      .filter((e) => (e.body as { event_type: string }).event_type === "agent_idle");
    expect(idle).toHaveLength(1); // same beep within the window → suppressed
  });

  it("offline: unreachable backend queues the event + returns fast, draining on a later send", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    await opencodeAdapter.install();

    const offline = createSender({
      baseUrl: sink.url,
      tokenOptions: FILE_ONLY,
      fetchImpl: () => Promise.reject(new Error("offline")),
    });
    const start = Date.now();
    const queued = await runOpenCodeHook(
      { type: "session.idle", properties: { sessionID: SID }, cwd: RAW_CWD },
      { sender: offline },
    );
    expect(queued.outcome).toBe("queued");
    expect(Date.now() - start).toBeLessThan(5000); // fast despite being offline
    expect(sink.received()).toHaveLength(0);

    const online = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });
    const drain = await online.drainNow();
    expect(drain.delivered).toBe(1);
    expect(sink.received()).toHaveLength(1);
    expect((sink.received()[0]!.body as { event_type: string }).event_type).toBe("agent_idle");
  });
});
