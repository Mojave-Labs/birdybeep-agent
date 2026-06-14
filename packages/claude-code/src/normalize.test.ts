/**
 * CC-NORMALIZE proof (pure logic; no HOME/network): table-driven over real-shaped
 * Claude Code hook payloads — every mapped event asserts event_type, session status,
 * §10.5 notify-default, and schema validity; plus deterministic best-effort session
 * id, typed rejection of garbled payloads, and the privacy invariant (cwd hashed).
 */
import { birdyBeepAgentEventSchema } from "@birdybeep/agent-core";
import { describe, expect, it } from "vitest";

import { ClaudeCodeMappingError, normalizeClaudeCodeEvent } from "./normalize";

const DET = { now: () => "2026-06-14T00:00:00.000Z", generateId: () => "evt_fixed" };

// VENDORED §10.5 default-notify (the six attention events beep). Asserts the §9.5
// notify column stays consistent with §10.1/§10.5.
const NOTIFY_DEFAULT: Record<string, boolean> = {
  session_started: false,
  session_resumed: false,
  agent_idle: true,
  needs_input: true,
  approval_required: true,
  agent_completed: true,
  agent_failed: true,
  subagent_completed: false,
};

const RAW_CWD = "/Users/alex/code/myapp";
const base = {
  session_id: "sess_cc_1",
  transcript_path: "/Users/alex/.claude/transcripts/x.jsonl",
  cwd: RAW_CWD,
};

interface Case {
  name: string;
  payload: Record<string, unknown>;
  eventType: string;
  status: string;
}

const cases: Case[] = [
  {
    name: "SessionStart (startup)",
    payload: {
      ...base,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "claude-sonnet-4-6",
    },
    eventType: "session_started",
    status: "starting",
  },
  {
    name: "SessionStart (resume)",
    payload: { ...base, hook_event_name: "SessionStart", source: "resume" },
    eventType: "session_resumed",
    status: "running",
  },
  {
    name: "Notification (permission_prompt)",
    payload: {
      ...base,
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Allow Bash?",
    },
    eventType: "approval_required",
    status: "waiting_for_approval",
  },
  {
    name: "Notification (idle_prompt)",
    payload: {
      ...base,
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      message: "Still there?",
    },
    eventType: "agent_idle",
    status: "idle",
  },
  {
    name: "Notification (other)",
    payload: {
      ...base,
      hook_event_name: "Notification",
      notification_type: "auth_success",
      message: "Logged in",
    },
    eventType: "needs_input",
    status: "waiting_for_input",
  },
  {
    name: "PermissionRequest",
    payload: {
      ...base,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    },
    eventType: "approval_required",
    status: "waiting_for_approval",
  },
  {
    name: "Stop",
    payload: { ...base, hook_event_name: "Stop" },
    eventType: "agent_completed",
    status: "completed",
  },
  {
    name: "StopFailure",
    payload: { ...base, hook_event_name: "StopFailure", error_type: "rate_limit" },
    eventType: "agent_failed",
    status: "failed",
  },
  {
    name: "SubagentStop",
    payload: { ...base, hook_event_name: "SubagentStop", agent_type: "Explore", agent_id: "sub_1" },
    eventType: "subagent_completed",
    status: "running",
  },
];

describe("§9.5 → §10.1 mapping", () => {
  it.each(cases)("$name → correct type/status/notify/valid", async (c) => {
    const ev = await normalizeClaudeCodeEvent(c.payload, DET);
    expect(ev.event_type).toBe(c.eventType);
    expect(ev.status).toBe(c.status);
    expect(ev.harness).toBe("claude_code");
    expect(ev.source_session_id).toBe("sess_cc_1");
    expect(birdyBeepAgentEventSchema.safeParse(ev).success).toBe(true);
    // §10.5 notify default is consistent with the produced event_type.
    expect(NOTIFY_DEFAULT[ev.event_type]).toBe(NOTIFY_DEFAULT[c.eventType]);
  });

  it("carries StopFailure error_type into metadata", async () => {
    const ev = await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "StopFailure", error_type: "overloaded" },
      DET,
    );
    expect((ev.metadata as Record<string, unknown>)["error_type"]).toBe("overloaded");
  });
});

describe("session identity (§10.3)", () => {
  it("derives a deterministic best-effort id when session_id is absent", async () => {
    const payload = {
      hook_event_name: "Stop",
      cwd: RAW_CWD,
      transcript_path: base.transcript_path,
    };
    const a = await normalizeClaudeCodeEvent(payload, DET);
    const b = await normalizeClaudeCodeEvent(payload, DET);
    expect(a.source_session_id).toMatch(/^cc_[0-9a-f]{16}$/);
    expect(a.source_session_id).toBe(b.source_session_id); // stable
  });
});

describe("garbled payloads reject (typed error, never a malformed event)", () => {
  it("rejects a payload with no hook_event_name", async () => {
    await expect(normalizeClaudeCodeEvent({ session_id: "x" })).rejects.toBeInstanceOf(
      ClaudeCodeMappingError,
    );
  });
  it("rejects an unknown hook event", async () => {
    await expect(
      normalizeClaudeCodeEvent({ ...base, hook_event_name: "Bogus" }),
    ).rejects.toBeInstanceOf(ClaudeCodeMappingError);
  });
});

describe("privacy (delegated to CORE-NORMALIZE)", () => {
  it("hashes the absolute cwd — no raw path in the delivered event", async () => {
    const ev = await normalizeClaudeCodeEvent({ ...base, hook_event_name: "Stop" }, DET);
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain(RAW_CWD);
    expect(serialized).not.toContain(base.transcript_path);
    expect(ev.workspace.cwd).toMatch(/^h_[0-9a-f]{16}$/);
  });
});
