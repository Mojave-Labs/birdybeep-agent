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
import { readFileSync } from "node:fs";

import { createSender, setToken, unavailableKeychainBackend } from "@birdybeep/agent-core";
import {
  createSandbox,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

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
      event: { type: "permission.updated", properties: { sessionID: SID, type: "bash" } },
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
