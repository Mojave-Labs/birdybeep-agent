/**
 * CUR-NORMALIZE proof (pure logic; no HOME/network): table-driven over real-shaped Cursor
 * hook payloads — every mapped event asserts event_type, session status, §10.5 notify-default,
 * and schema validity; plus deterministic best-effort session id, typed rejection of garbled
 * payloads, one test per mapping branch, and the privacy invariants (cwd hashed, user_email +
 * transcript_path dropped entirely).
 */
import { birdyBeepAgentEventSchema } from "@birdybeep/agent-core";
import { describe, expect, it } from "vitest";

import postToolUseFailureFixture from "./__fixtures__/postToolUseFailure.json";
import postToolUseFailureInterruptFixture from "./__fixtures__/postToolUseFailure-interrupt.json";
import { CursorMappingError, normalizeCursorEvent } from "./normalize";

const DET = { now: () => "2026-07-15T00:00:00.000Z", generateId: () => "evt_fixed" };

// VENDORED §10.5 default-notify (the attention events beep; activity updates do not).
const NOTIFY_DEFAULT: Record<string, boolean> = {
  session_started: false,
  agent_completed: true,
  agent_failed: true, // the failure beep — postToolUseFailure (gcgp.17)
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
    // gcgp.9 — the MCP permission gate, sibling of beforeShellExecution.
    name: "beforeMCPExecution",
    payload: {
      ...base,
      hook_event_name: "beforeMCPExecution",
      tool_name: "execute_sql",
      tool_input: '{"query":"select 1"}',
      mcp_server_name: "supabase",
      command: "npx -y @supabase/mcp-server --access-token sbp_TESTONLY_secret",
    },
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
    // gcgp.17 — the tool-failure beep. Fields per Cursor's own PostToolUseFailure schema.
    name: "postToolUseFailure",
    payload: {
      ...base,
      hook_event_name: "postToolUseFailure",
      tool_name: "Bash",
      failure_type: "tool_error",
      duration_ms: 1843,
      is_interrupt: false,
    },
    eventType: "agent_failed",
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

  it("beforeMCPExecution beeps exactly like beforeShellExecution (gcgp.9)", async () => {
    const mcp = await normalizeCursorEvent(
      {
        ...base,
        hook_event_name: "beforeMCPExecution",
        tool_name: "execute_sql",
        mcp_server_name: "supabase",
      },
      DET,
    );
    const shell = await normalizeCursorEvent(
      { ...base, hook_event_name: "beforeShellExecution", command: "terraform apply" },
      DET,
    );
    expect(mcp.event_type).toBe(shell.event_type); // both approval_required
    expect(mcp.status).toBe(shell.status); // both waiting_for_approval
    expect(mcp.title).toBe(shell.title);
    expect(NOTIFY_DEFAULT[mcp.event_type]).toBe(true); // …and it beeps
    expect(mcp.body).toBe("Approve MCP tool execute_sql?");
    const metadata = mcp.metadata as Record<string, unknown>;
    expect(metadata["tool"]).toBe("execute_sql");
    expect(metadata["mcp_server"]).toBe("supabase");
  });

  it("beforeMCPExecution without a tool name still produces a usable approval beep", async () => {
    const ev = await normalizeCursorEvent({ ...base, hook_event_name: "beforeMCPExecution" }, DET);
    expect(ev.event_type).toBe("approval_required");
    expect(ev.body).toBe("Approve MCP tool?");
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
    // gcgp.17 de-registered both: they are no longer written into hooks.json, but a config
    // an earlier release patched still fires them, so they must stay a quiet skip.
    for (const name of ["beforeSubmitPrompt", "afterAgentResponse"]) {
      await expect(normalizeCursorEvent({ ...base, hook_event_name: name })).rejects.toBeInstanceOf(
        CursorMappingError,
      );
    }
  });
});

/**
 * birdybeep-agent-gcgp.17 — `postToolUseFailure` was registered and mapped to nothing, so
 * every fire spawned a hook process to produce `skipped`. Driven here with the fixture whose
 * field set is Cursor's own `agent.v1.PostToolUseFailureRequestQuery` (see
 * `__fixtures__/README.md`), not a hand-written shape.
 */
describe("postToolUseFailure → agent_failed (gcgp.17)", () => {
  it("produces the Beep-eligible failure event from the real payload shape", async () => {
    const ev = await normalizeCursorEvent(postToolUseFailureFixture, DET);
    expect(ev.event_type).toBe("agent_failed");
    expect(NOTIFY_DEFAULT[ev.event_type]).toBe(true); // the whole point: this one beeps
    expect(ev.title).toBe("Cursor tool failed");
    expect(ev.body).toBe("Bash failed");
    expect(birdyBeepAgentEventSchema.safeParse(ev).success).toBe(true);
    const metadata = ev.metadata as Record<string, unknown>;
    expect(metadata["tool"]).toBe("Bash");
    expect(metadata["failure_type"]).toBe("tool_error");
    expect(metadata["duration_ms"]).toBe(1843);
  });

  it("leaves the session status `running` — one failed tool is not a failed session", async () => {
    const ev = await normalizeCursorEvent(postToolUseFailureFixture, DET);
    expect(ev.status).toBe("running");
  });

  it("drops error_message and tool_input — a tool's own error text is content", async () => {
    const ev = await normalizeCursorEvent(postToolUseFailureFixture, DET);
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain("password authentication failed");
    expect(serialized).not.toContain("sbp_TESTONLY_secret");
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("/home/user");
  });

  it("a user interrupt is a quiet skip, not a failure beep", async () => {
    // is_interrupt means the user pressed stop: the person who would get the beep is the
    // person who just cancelled the tool.
    await expect(normalizeCursorEvent(postToolUseFailureInterruptFixture)).rejects.toBeInstanceOf(
      CursorMappingError,
    );
  });

  it("falls back to a usable body when Cursor sends no tool name", async () => {
    const ev = await normalizeCursorEvent(
      { ...base, hook_event_name: "postToolUseFailure", failure_type: "tool_error" },
      DET,
    );
    expect(ev.body).toBe("A tool failed");
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

  it("beforeMCPExecution drops tool_input and the MCP server launch line (gcgp.9)", async () => {
    // Cursor hands this hook the full tool arguments AND the server's command line, which
    // routinely carries an access token. Neither may be read, let alone sent.
    const ev = await normalizeCursorEvent(
      {
        ...base,
        hook_event_name: "beforeMCPExecution",
        tool_name: "execute_sql",
        tool_input: '{"query":"select * from users where email = \'a@b.c\'"}',
        mcp_server_name: "supabase",
        mcp_server_url: "https://mcp.internal.example.com/sse?key=SECRETKEY",
        command: "npx -y @supabase/mcp-server --access-token sbp_TESTONLY_secret",
      },
      DET,
    );
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain("sbp_TESTONLY_secret");
    expect(serialized).not.toContain("SECRETKEY");
    expect(serialized).not.toContain("mcp.internal.example.com");
    expect(serialized).not.toContain("select * from users");
    expect(serialized).not.toContain("a@b.c");
  });
});
