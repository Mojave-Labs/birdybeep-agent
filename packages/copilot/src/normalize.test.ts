import { describe, expect, it } from "vitest";

import agentStopFixture from "./__fixtures__/agentStop.json";
import postToolUseFixture from "./__fixtures__/postToolUse.json";
import preToolUseFixture from "./__fixtures__/preToolUse.json";
import sessionEndFixture from "./__fixtures__/sessionEnd.json";
import sessionStartFixture from "./__fixtures__/sessionStart.json";
import userPromptSubmittedFixture from "./__fixtures__/userPromptSubmitted.json";
import { COPILOT_HOOK_EVENTS } from "./install";
import { CopilotMappingError, isCopilotHookPayload, normalizeCopilotEvent } from "./normalize";

const base = {
  sessionId: "copilot-session-1",
  timestamp: 1786075913995,
  cwd: "/Users/alice/secret-project",
};

const CASES = [
  [
    "sessionStart",
    { ...base, source: "new", initialPrompt: "RAW INITIAL PROMPT" },
    "session_started",
    "starting",
  ],
  ["userPromptSubmitted", { ...base, prompt: "RAW USER PROMPT" }, "session_active", "running"],
  [
    "preToolUse",
    { ...base, toolName: "bash", toolArgs: '{"command":"RAW COMMAND"}' },
    "tool_started",
    "running",
  ],
  [
    "postToolUse",
    {
      ...base,
      toolName: "bash",
      toolArgs: "RAW ARGS",
      toolResult: { resultType: "success", textResultForLlm: "RAW OUTPUT" },
    },
    "tool_finished",
    "running",
  ],
  [
    "agentStop",
    { ...base, transcriptPath: "/Users/alice/.copilot/private.jsonl", stopReason: "end_turn" },
    "agent_completed",
    "completed",
  ],
  [
    "subagentStop",
    {
      ...base,
      transcriptPath: "/Users/alice/private.jsonl",
      agentName: "research",
      agentType: "custom",
      response: "RAW SUBAGENT RESPONSE",
      stopReason: "end_turn",
    },
    "subagent_completed",
    "running",
  ],
  [
    "errorOccurred",
    {
      ...base,
      error: {
        name: "PrivateError",
        message: "RAW ERROR MESSAGE",
        stack: "RAW STACK /Users/alice/file",
      },
      errorContext: "tool_execution",
      recoverable: false,
    },
    "agent_failed",
    "failed",
  ],
  ["sessionEnd", { ...base, reason: "complete" }, "session_ended", "completed"],
] as const;

describe("normalizeCopilotEvent", () => {
  it("covers the exact installed event set", () => {
    expect(CASES.map(([name]) => name)).toEqual(COPILOT_HOOK_EVENTS);
  });

  for (const [eventName, payload, eventType, status] of CASES) {
    it(`${eventName} → ${eventType}`, async () => {
      const event = await normalizeCopilotEvent(eventName, payload, {
        now: () => "2026-08-06T12:00:00.000Z",
      });
      expect(event).toMatchObject({
        harness: "copilot",
        event_type: eventType,
        status,
        source_session_id: base.sessionId,
      });
      expect(event.workspace.cwd).toMatch(/^h_[0-9a-f]{16}$/);
    });
  }

  it("drops every raw content and filesystem field", async () => {
    const forbidden = [
      "RAW INITIAL PROMPT",
      "RAW USER PROMPT",
      "RAW COMMAND",
      "RAW ARGS",
      "RAW OUTPUT",
      "RAW SUBAGENT RESPONSE",
      "RAW ERROR MESSAGE",
      "RAW STACK",
      "/Users/alice",
      ".jsonl",
    ];
    for (const [eventName, payload] of CASES) {
      const serialized = JSON.stringify(await normalizeCopilotEvent(eventName, payload));
      for (const raw of forbidden) expect(serialized).not.toContain(raw);
    }
  });

  it("uses a deterministic fallback id when sessionId is absent", async () => {
    const first = await normalizeCopilotEvent("sessionStart", { cwd: base.cwd, source: "new" });
    const second = await normalizeCopilotEvent("sessionStart", { cwd: base.cwd, source: "new" });
    expect(first.source_session_id).toBe(second.source_session_id);
    expect(first.source_session_id).toMatch(/^cop_[0-9a-f]{16}$/);
  });

  it("rejects an unsupported or missing event name", async () => {
    await expect(normalizeCopilotEvent("notification", base)).rejects.toBeInstanceOf(
      CopilotMappingError,
    );
    await expect(normalizeCopilotEvent("", base)).rejects.toBeInstanceOf(CopilotMappingError);
  });
});

/**
 * birdybeep-agent-gcgp.7 — Copilot's payloads carry no version, but the CLI exports
 * `COPILOT_CLI_BINARY_VERSION` into every hook child. Captured live from a real
 * `copilot -p` run on 2026-08-16: 1.0.78, matching `copilot --version`.
 */
describe("harness_version from COPILOT_CLI_BINARY_VERSION (gcgp.7)", () => {
  const env = { COPILOT_CLI_BINARY_VERSION: "1.0.78" };

  it("rides every mapped event", async () => {
    for (const [eventName, payload] of CASES) {
      const ev = await normalizeCopilotEvent(eventName, payload, { env });
      expect(ev.harness_version, eventName).toBe("1.0.78");
    }
  });

  it("is omitted, never guessed, when Copilot exports nothing", async () => {
    const ev = await normalizeCopilotEvent("sessionStart", base, { env: {} });
    expect(ev.harness_version).toBeUndefined();
  });

  it("rejects a junk value instead of forwarding it", async () => {
    const ev = await normalizeCopilotEvent("sessionStart", base, {
      env: { COPILOT_CLI_BINARY_VERSION: "/usr/local/bin/copilot --version" },
    });
    expect(ev.harness_version).toBeUndefined();
    expect(JSON.stringify(ev)).not.toContain("/usr/local/bin");
  });
});

/**
 * birdybeep-agent-gcgp.14 — Copilot is the one harness whose payloads carry NO event
 * discriminator (the event name is an argv argument), so `normalizeCopilotEvent` maps whatever
 * object it is handed. A foreign payload therefore did not skip quietly: it produced a
 * FABRICATED Copilot event and sent it. Reproduced before the fix by piping a real Cursor
 * `sessionStart` into `birdybeep hook copilot sessionStart` — a `session_started` came out.
 *
 * Fixtures are the real captured Copilot CLI 1.0.70 payloads (`__fixtures__/README.md`).
 */
describe("isCopilotHookPayload — foreign payloads are recognized as foreign (gcgp.14)", () => {
  it("accepts every real captured Copilot payload", () => {
    const fixtures = {
      sessionStart: sessionStartFixture,
      userPromptSubmitted: userPromptSubmittedFixture,
      preToolUse: preToolUseFixture,
      postToolUse: postToolUseFixture,
      agentStop: agentStopFixture,
      sessionEnd: sessionEndFixture,
    };
    for (const [name, payload] of Object.entries(fixtures)) {
      expect(isCopilotHookPayload(payload), name).toBe(true);
    }
  });

  it("accepts every payload in the mapping table above", () => {
    for (const [name, payload] of CASES) {
      expect(isCopilotHookPayload(payload), name as string).toBe(true);
    }
  });

  it("rejects the real payloads of every OTHER harness — they use snake_case session_id", () => {
    expect(
      isCopilotHookPayload({
        hook_event_name: "sessionStart",
        cursor_version: "3.14.27",
        workspace_roots: ["/Users/alice/secret-project"],
        session_id: "s",
      }),
    ).toBe(false);
    expect(
      isCopilotHookPayload({ hook_event_name: "SessionStart", session_id: "s", cwd: base.cwd }),
    ).toBe(false);
    expect(isCopilotHookPayload({ type: "agent-turn-complete", "thread-id": "t" })).toBe(false);
    expect(isCopilotHookPayload({ type: "session.idle", properties: { sessionID: "s" } })).toBe(
      false,
    );
  });

  it("rejects a non-object and a payload with no session id", () => {
    for (const value of [null, undefined, 3, "sessionStart", [], {}, { cwd: base.cwd }]) {
      expect(isCopilotHookPayload(value)).toBe(false);
    }
  });

  it("does not require cwd or timestamp — a future event omitting one must stay mappable", () => {
    expect(isCopilotHookPayload({ sessionId: "copilot-session-1" })).toBe(true);
  });
});
