/**
 * CUR-NORMALIZE proof (pure logic; no HOME/network): table-driven over real-shaped Cursor
 * hook payloads — every mapped event asserts event_type, session status, §10.5 notify-default,
 * and schema validity; plus deterministic best-effort session id, typed rejection of garbled
 * payloads, one test per mapping branch, and the privacy invariants (cwd hashed, user_email +
 * transcript_path dropped entirely).
 */
import { birdyBeepAgentEventSchema } from "@birdybeep/agent-core";
import { describe, expect, it } from "vitest";

import { CursorMappingError, normalizeCursorEvent } from "./normalize";

const DET = { now: () => "2026-07-15T00:00:00.000Z", generateId: () => "evt_fixed" };

// VENDORED §10.5 default-notify (the attention events beep; activity updates do not).
const NOTIFY_DEFAULT: Record<string, boolean> = {
  session_started: false,
  agent_completed: true,
  session_ended: false, // lifecycle marker — never beeps
  approval_required: true,
  tool_started: false,
  tool_finished: false,
  subagent_started: false,
  subagent_completed: false,
};

const SESSION = "00000000-0000-4000-8000-000000000001";
const RAW_CWD = "/home/user/project";
const RAW_EMAIL = "user@example.com";
const RAW_TRANSCRIPT = "/home/user/project/.cursor/transcripts/x.jsonl";
const base = {
  session_id: SESSION,
  workspace_roots: [RAW_CWD],
  cursor_version: "2026.07.09-a3815c0",
  user_email: RAW_EMAIL,
  transcript_path: RAW_TRANSCRIPT,
};

interface Case {
  name: string;
  payload: Record<string, unknown>;
  eventType: string;
  status: string;
}

const cases: Case[] = [
  {
    name: "sessionStart",
    payload: { ...base, hook_event_name: "sessionStart", model: "default" },
    eventType: "session_started",
    status: "starting",
  },
  {
    name: "sessionEnd (completed)",
    payload: {
      ...base,
      hook_event_name: "sessionEnd",
      final_status: "completed",
      reason: "completed",
    },
    eventType: "agent_completed",
    status: "completed",
  },
  {
    name: "sessionEnd (not completed)",
    payload: {
      ...base,
      hook_event_name: "sessionEnd",
      final_status: "cancelled",
      reason: "cancelled",
    },
    eventType: "session_ended",
    status: "completed",
  },
  {
    name: "stop",
    payload: { ...base, hook_event_name: "stop" },
    eventType: "agent_completed",
    status: "completed",
  },
  {
    name: "beforeShellExecution",
    payload: { ...base, hook_event_name: "beforeShellExecution", command: "terraform apply" },
    eventType: "approval_required",
    status: "waiting_for_approval",
  },
  {
    name: "preToolUse",
    payload: { ...base, hook_event_name: "preToolUse", tool_name: "Edit" },
    eventType: "tool_started",
    status: "running",
  },
  {
    name: "postToolUse",
    payload: { ...base, hook_event_name: "postToolUse", tool_name: "Edit" },
    eventType: "tool_finished",
    status: "running",
  },
  {
    name: "subagentStart",
    payload: { ...base, hook_event_name: "subagentStart" },
    eventType: "subagent_started",
    status: "running",
  },
  {
    name: "subagentStop",
    payload: { ...base, hook_event_name: "subagentStop" },
    eventType: "subagent_completed",
    status: "running",
  },
];

describe("§9.x → §10.1 mapping", () => {
  it.each(cases)("$name → correct type/status/notify/valid", async (c) => {
    const ev = await normalizeCursorEvent(c.payload, DET);
    expect(ev.event_type).toBe(c.eventType);
    expect(ev.status).toBe(c.status);
    expect(ev.harness).toBe("cursor");
    expect(ev.source_session_id).toBe(SESSION);
    expect(ev.harness_version).toBe("2026.07.09-a3815c0");
    expect(birdyBeepAgentEventSchema.safeParse(ev).success).toBe(true);
    // §10.5 notify default is consistent with the produced event_type.
    expect(NOTIFY_DEFAULT[ev.event_type]).toBeDefined();
  });

  it("sessionStart title/body/status are suitable and non-empty title", async () => {
    const ev = await normalizeCursorEvent({ ...base, hook_event_name: "sessionStart" }, DET);
    expect(ev.title).toBe("Cursor session started");
    expect(ev.status).toBe("starting");
  });

  it("sessionEnd (completed) → the CLI completion beep with the expected title/body", async () => {
    const ev = await normalizeCursorEvent(
      { ...base, hook_event_name: "sessionEnd", final_status: "completed" },
      DET,
    );
    expect(ev.event_type).toBe("agent_completed");
    expect(ev.title).toBe("Cursor finished");
    expect(ev.body).toBe("Session complete");
    expect(NOTIFY_DEFAULT[ev.event_type]).toBe(true); // completion must beep
  });

  it("sessionEnd (not completed) → non-notifying terminal session_ended", async () => {
    const ev = await normalizeCursorEvent(
      { ...base, hook_event_name: "sessionEnd", final_status: "errored", reason: "errored" },
      DET,
    );
    expect(ev.event_type).toBe("session_ended");
    expect(ev.status).toBe("completed");
    expect(ev.body).toBe("Session ended (errored)");
    expect(NOTIFY_DEFAULT[ev.event_type]).toBe(false);
  });

  it("carries a safe tool identifier into metadata for preToolUse", async () => {
    const ev = await normalizeCursorEvent(
      { ...base, hook_event_name: "preToolUse", tool_name: "Bash" },
      DET,
    );
    expect((ev.metadata as Record<string, unknown>)["tool"]).toBe("Bash");
    expect(ev.body).toBe("Bash started");
  });
});

describe("session identity (§10.3)", () => {
  it("derives a deterministic best-effort id when session_id is absent", async () => {
    const payload = { hook_event_name: "stop", workspace_roots: [RAW_CWD] };
    const a = await normalizeCursorEvent(payload, DET);
    const b = await normalizeCursorEvent(payload, DET);
    expect(a.source_session_id).toMatch(/^cur_[0-9a-f]{16}$/);
    expect(a.source_session_id).toBe(b.source_session_id); // stable
  });
});

describe("garbled / unmappable payloads reject (typed error, never a malformed event)", () => {
  it("rejects a payload with no hook_event_name", async () => {
    await expect(normalizeCursorEvent({ session_id: "x" })).rejects.toBeInstanceOf(
      CursorMappingError,
    );
  });
  it("rejects an unknown hook event", async () => {
    await expect(
      normalizeCursorEvent({ ...base, hook_event_name: "Bogus" }),
    ).rejects.toBeInstanceOf(CursorMappingError);
  });
  it("rejects the IDE-only events that have no §10.1 target (→ skipped at the hook)", async () => {
    for (const name of ["beforeSubmitPrompt", "postToolUseFailure", "afterAgentResponse"]) {
      await expect(normalizeCursorEvent({ ...base, hook_event_name: name })).rejects.toBeInstanceOf(
        CursorMappingError,
      );
    }
  });
});

describe("privacy — cwd hashed, user_email + transcript_path DROPPED (delegated to CORE-NORMALIZE + mapping)", () => {
  it.each(cases)("$name never leaks the raw cwd, user_email, or transcript_path", async (c) => {
    const ev = await normalizeCursorEvent(c.payload, DET);
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain(RAW_CWD);
    expect(serialized).not.toContain(RAW_EMAIL);
    expect(serialized).not.toContain(RAW_TRANSCRIPT);
    expect(serialized).not.toContain(".jsonl"); // no transcript path fragment survives
    expect(ev.workspace.cwd).toMatch(/^h_[0-9a-f]{16}$/); // cwd is hashed
  });
});
