import { describe, expect, it } from "vitest";

import { COPILOT_HOOK_EVENTS } from "./install";
import { CopilotMappingError, normalizeCopilotEvent } from "./normalize";

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
