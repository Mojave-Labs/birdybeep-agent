/**
 * runClaudeHook proof: a real Claude Code hook payload runs through the shared pipeline to
 * the stub sink (delivered, harness=claude_code), and an unmappable payload is skipped
 * (never delivered, never throws). Symmetric with runCodexHook / runOpenCodeHook.
 */
import { randomUUID } from "node:crypto";

import { createSender, setToken, unavailableKeychainBackend } from "@birdybeep/agent-core";
import {
  createSandbox,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runClaudeHook } from "./hook";

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

describe("runClaudeHook", () => {
  it("delivers a normalized event for a real Claude Code hook payload", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });

    const result = await runClaudeHook(
      { hook_event_name: "Stop", session_id: "sess-1", cwd: "/Users/dev/project" },
      { sender },
    );
    expect(result.outcome).toBe("delivered");
    expect(sink.received()).toHaveLength(1);
    const body = sink.received()[0]!.body as { event_type: string; harness: string };
    expect(body.event_type).toBe("agent_completed");
    expect(body.harness).toBe("claude_code");
  });

  it("skips an unmappable payload (never delivered, never throws)", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });

    const result = await runClaudeHook({ hook_event_name: "PreCompact" }, { sender });
    expect(result.outcome).toBe("skipped");
    expect(sink.received()).toHaveLength(0);
  });
});
