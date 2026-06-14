/**
 * CX-NORMALIZE proof: every Codex surface in the §9.6 table maps to the exact §10.1
 * event type, §10.4 status, and §10.5 notify-default (which follows from event_type);
 * privacy invariants hold (cwd hashed, no raw absolute paths, no user/assistant content
 * persisted); session identity is stable across events of one session; and unknown
 * payloads reject (CodexMappingError) rather than emit garbage.
 *
 * Fixtures use the REAL Codex payload shapes (verified against openai/codex source):
 * notify = argv JSON, kebab-case keys, keyed by `type`; hooks = stdin JSON, snake_case
 * keys, keyed by `hook_event_name`.
 */
import { describe, expect, it } from "vitest";

import { CodexMappingError, normalizeCodexEvent } from "./normalize";

const OPTS = { now: () => "2026-06-14T00:00:00.000Z", generateId: () => "evt_test_1" } as const;
const CWD = "/Users/alice/project";

interface Case {
  name: string;
  payload: Record<string, unknown>;
  eventType: string;
  status: string;
  body: string;
  /** §10.5 notify-default (documentation; the server derives it from event_type). */
  notifyDefault: boolean;
}

const CASES: Case[] = [
  {
    name: "notify agent-turn-complete → agent_completed",
    payload: {
      type: "agent-turn-complete",
      "thread-id": "thread-abc-123",
      "turn-id": "turn-42",
      cwd: CWD,
      client: "codex-tui",
      "input-messages": ["Rename foo to bar"],
      "last-assistant-message": "Done.",
    },
    eventType: "agent_completed",
    status: "completed",
    body: "Turn complete",
    notifyDefault: true,
  },
  {
    name: "hook SessionStart (startup) → session_started",
    payload: {
      hook_event_name: "SessionStart",
      session_id: "sess-1",
      cwd: CWD,
      source: "startup",
      model: "gpt-5",
    },
    eventType: "session_started",
    status: "starting",
    body: "",
    notifyDefault: false,
  },
  {
    name: "hook SessionStart (resume) → session_resumed",
    payload: { hook_event_name: "SessionStart", session_id: "sess-1", cwd: CWD, source: "resume" },
    eventType: "session_resumed",
    status: "running",
    body: "",
    notifyDefault: false,
  },
  {
    name: "hook PermissionRequest → approval_required",
    payload: {
      hook_event_name: "PermissionRequest",
      session_id: "sess-1",
      cwd: CWD,
      tool_name: "Bash",
      tool_input: { command: "rm -rf /Users/alice/secret-dir/data" },
    },
    eventType: "approval_required",
    status: "waiting_for_approval",
    body: "Approve Bash?",
    notifyDefault: true,
  },
  {
    name: "hook PostToolUse → tool_finished",
    payload: {
      hook_event_name: "PostToolUse",
      session_id: "sess-1",
      cwd: CWD,
      tool_name: "Edit",
      tool_input: { file_path: "/Users/alice/project/src/secret.ts" },
      tool_response: { ok: true },
      tool_use_id: "tu-1",
    },
    eventType: "tool_finished",
    status: "running",
    body: "Edit finished",
    notifyDefault: false,
  },
  {
    name: "hook SubagentStart → subagent_started",
    payload: {
      hook_event_name: "SubagentStart",
      session_id: "sess-1",
      cwd: CWD,
      agent_type: "explorer",
      agent_id: "sub-1",
    },
    eventType: "subagent_started",
    status: "running",
    body: "Subtask started",
    notifyDefault: false,
  },
  {
    name: "hook SubagentStop → subagent_completed",
    payload: {
      hook_event_name: "SubagentStop",
      session_id: "sess-1",
      cwd: CWD,
      agent_type: "explorer",
      agent_id: "sub-1",
    },
    eventType: "subagent_completed",
    status: "running",
    body: "Subtask complete",
    notifyDefault: false,
  },
  {
    name: "hook Stop → agent_completed",
    payload: { hook_event_name: "Stop", session_id: "sess-1", cwd: CWD },
    eventType: "agent_completed",
    status: "completed",
    body: "Turn complete",
    notifyDefault: true,
  },
];

describe("§9.6 → §10.1 mapping table", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const evt = await normalizeCodexEvent(c.payload, OPTS);
      expect(evt.event_type).toBe(c.eventType);
      expect(evt.status).toBe(c.status);
      expect(evt.body).toBe(c.body);
      expect(evt.harness).toBe("codex");
      // cwd is always hashed (§10.3) — never the raw absolute path.
      expect(evt.workspace.cwd).toMatch(/^h_[0-9a-f]{16}$/);
      // Output uses only enum values from BirdyBeepEventType / AgentSessionStatus.
      expect(evt.event_id).toBe("evt_test_1");
      expect(evt.occurred_at).toBe("2026-06-14T00:00:00.000Z");
    });
  }
});

describe("session identity (§10.3)", () => {
  it("derives source_session_id from notify thread-id", async () => {
    const evt = await normalizeCodexEvent(
      { type: "agent-turn-complete", "thread-id": "thread-xyz", cwd: CWD },
      OPTS,
    );
    expect(evt.source_session_id).toBe("thread-xyz");
  });

  it("derives source_session_id from hook session_id and is stable across a session", async () => {
    const first = await normalizeCodexEvent(
      { hook_event_name: "PostToolUse", session_id: "sess-stable", cwd: CWD, tool_name: "Bash" },
      OPTS,
    );
    const second = await normalizeCodexEvent(
      { hook_event_name: "Stop", session_id: "sess-stable", cwd: CWD },
      OPTS,
    );
    expect(first.source_session_id).toBe("sess-stable");
    expect(second.source_session_id).toBe("sess-stable");
  });

  it("falls back to a deterministic best-effort id when none is provided", async () => {
    const payload = { hook_event_name: "Stop", cwd: CWD };
    const a = await normalizeCodexEvent(payload, OPTS);
    const b = await normalizeCodexEvent(payload, OPTS);
    expect(a.source_session_id).toMatch(/^cx_[0-9a-f]{16}$/);
    expect(a.source_session_id).toBe(b.source_session_id);
  });
});

describe("privacy invariants (§15.6)", () => {
  it("hashes the cwd and never lets a raw absolute path through", async () => {
    const evt = await normalizeCodexEvent(
      { hook_event_name: "PostToolUse", session_id: "s", cwd: CWD, tool_name: "Edit" },
      OPTS,
    );
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain(CWD);
    expect(serialized).not.toMatch(/\/Users\/alice/);
  });

  it("never persists user/assistant content from notify (input/last-assistant-message)", async () => {
    const secret = "Token sk-abcdefghijklmnop1234 lives at /Users/alice/.ssh/id_rsa";
    const evt = await normalizeCodexEvent(
      {
        type: "agent-turn-complete",
        "thread-id": "t",
        cwd: CWD,
        "input-messages": ["please leak /Users/alice/secret"],
        "last-assistant-message": secret,
      },
      OPTS,
    );
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain("sk-abcdefghijklmnop1234");
    expect(serialized).not.toContain("id_rsa");
    expect(serialized).not.toContain("please leak");
    expect(evt.body).toBe("Turn complete");
  });

  it("never persists tool_input content from a hook payload", async () => {
    const evt = await normalizeCodexEvent(
      {
        hook_event_name: "PermissionRequest",
        session_id: "s",
        cwd: CWD,
        tool_name: "Bash",
        tool_input: { command: "cat /Users/alice/secret-dir/credentials.json" },
      },
      OPTS,
    );
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain("credentials.json");
    expect(serialized).not.toContain("secret-dir");
    expect(evt.body).toBe("Approve Bash?");
  });
});

describe("unknown / garbled inputs reject (caught + skipped by runAgentHook)", () => {
  it("rejects an unknown hook_event_name", async () => {
    await expect(
      normalizeCodexEvent({ hook_event_name: "PreCompact", session_id: "s", cwd: CWD }),
    ).rejects.toBeInstanceOf(CodexMappingError);
  });

  it("rejects an unknown notify type", async () => {
    await expect(
      normalizeCodexEvent({ type: "some-future-type", cwd: CWD }),
    ).rejects.toBeInstanceOf(CodexMappingError);
  });

  it("rejects a payload with neither hook_event_name nor type", async () => {
    await expect(normalizeCodexEvent({ cwd: CWD })).rejects.toBeInstanceOf(CodexMappingError);
  });
});
