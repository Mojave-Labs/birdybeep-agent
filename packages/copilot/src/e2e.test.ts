/**
 * COPILOT-E2E: real captured Copilot CLI payloads through temp-HOME install, shared hook
 * pipeline, token store, sender, and HTTP sink. This is the hermetic adapter gate; the real
 * `copilot` binary + live backend gate is driven by `scripts/live-e2e-copilot.mjs`.
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import agentStop from "./__fixtures__/agentStop.json";
import postToolUse from "./__fixtures__/postToolUse.json";
import preToolUse from "./__fixtures__/preToolUse.json";
import sessionEnd from "./__fixtures__/sessionEnd.json";
import sessionStart from "./__fixtures__/sessionStart.json";
import userPromptSubmitted from "./__fixtures__/userPromptSubmitted.json";
import { copilotAdapter } from "./adapter";
import { runCopilotHook } from "./hook";
import type { CopilotHookEventName } from "./install";
import { copilotHooksPath } from "./paths";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };
const RAW_CWD = sessionStart.cwd;
const RAW_TRANSCRIPT = agentStop.transcriptPath;
const RAW_CONTENT = [
  sessionStart.initialPrompt,
  userPromptSubmitted.prompt,
  preToolUse.toolArgs,
  postToolUse.toolArgs,
  postToolUse.toolResult.textResultForLlm,
  RAW_TRANSCRIPT,
];

const ORIGINAL_COPILOT_HOME = process.env["COPILOT_HOME"];
beforeAll(() => delete process.env["COPILOT_HOME"]);
afterAll(() => {
  if (ORIGINAL_COPILOT_HOME === undefined) delete process.env["COPILOT_HOME"];
  else process.env["COPILOT_HOME"] = ORIGINAL_COPILOT_HOME;
});

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
});

const fixtures: [CopilotHookEventName, unknown, string][] = [
  ["sessionStart", sessionStart, "session_started"],
  ["userPromptSubmitted", userPromptSubmitted, "session_active"],
  ["preToolUse", preToolUse, "tool_started"],
  ["postToolUse", postToolUse, "tool_finished"],
  ["agentStop", agentStop, "agent_completed"],
  ["sessionEnd", sessionEnd, "session_ended"],
];

describe("COPILOT-E2E", () => {
  it("installs then delivers every real captured lifecycle payload without content leaks", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    const sb = sandbox;
    await setToken(TOKEN, FILE_ONLY);

    const installed = await copilotAdapter.install();
    expect(installed.status).toBe("installed");
    expect(await copilotAdapter.status()).toBe("installed");
    const config = readFileSync(copilotHooksPath({ home: sb.home, env: {} }), "utf8");
    expect(config).not.toContain(TOKEN);

    const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });
    const started = Date.now();
    for (const [eventName, payload] of fixtures) {
      expect((await runCopilotHook(eventName, payload, { sender })).outcome).toBe("delivered");
    }
    expect(Date.now() - started).toBeLessThan(5000);
    expect(sink.received()).toHaveLength(fixtures.length);

    for (const [index, [, , expectedType]] of fixtures.entries()) {
      const delivered = sink.received()[index]!;
      const body = delivered.body as Record<string, unknown>;
      expect(body["harness"]).toBe("copilot");
      expect(body["event_type"]).toBe(expectedType);
      expect(body["source_session_id"]).toBe("copilot-session-fixture");
      expect(deliveredBearerToken(delivered)).toBe(TOKEN);
      assertPathsHashed(delivered, [RAW_CWD, RAW_TRANSCRIPT, sb.home, sb.realHome]);
      assertNoAbsolutePaths(delivered);
      assertWithinSizeCap(delivered);
      assertNoRawValues(delivered, RAW_CONTENT, { scope: "body" });
      assertNoRawValues(delivered, [TOKEN], { scope: "body" });
    }
  });

  it("skips an unsupported event without delivering or throwing", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const result = await copilotAdapter
      .normalizeEvent({
        eventName: "notification",
        payload: sessionStart,
      })
      .catch(() => undefined);
    expect(result).toBeUndefined();
    expect(sink.received()).toHaveLength(0);
  });
});
