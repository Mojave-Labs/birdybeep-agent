/**
 * OC-NORMALIZE proof: every real OpenCode event in the §9.7 table maps to the exact §10.1
 * type + §10.4 status + §10.5 notify-default (which follows from event_type); session.status
 * variants resolve to distinct events; privacy holds (cwd hashed, no raw paths, no
 * user/assistant content persisted); and unmapped events (incl. permission.replied) reject
 * (OpenCodeMappingError) rather than emit garbage or invent a wire type.
 *
 * Fixtures use the REAL OpenCode plugin-event shape (verified against the SDK types):
 * { type, properties }, with `cwd` injected by the plugin (most bus events omit it).
 */
import { describe, expect, it } from "vitest";

import { normalizeOpenCodeEvent, OpenCodeMappingError } from "./normalize";

const OPTS = { now: () => "2026-06-14T00:00:00.000Z", generateId: () => "evt_test_1" } as const;
const CWD = "/Users/alice/opencode-project";
const SID = "ses_abc123";

interface Case {
  name: string;
  payload: Record<string, unknown>;
  eventType: string;
  status: string;
  /** §10.5 notify-default (documentation; the server derives it from event_type). */
  notifyDefault: boolean;
}

const CASES: Case[] = [
  {
    name: "session.created → session_started",
    payload: { type: "session.created", properties: { info: { id: SID } }, cwd: CWD },
    eventType: "session_started",
    status: "starting",
    notifyDefault: false,
  },
  {
    name: "session.updated → session_active",
    payload: { type: "session.updated", properties: { info: { id: SID } }, cwd: CWD },
    eventType: "session_active",
    status: "running",
    notifyDefault: false,
  },
  {
    name: "session.status {busy} → session_active",
    payload: {
      type: "session.status",
      properties: { sessionID: SID, status: { type: "busy" } },
      cwd: CWD,
    },
    eventType: "session_active",
    status: "running",
    notifyDefault: false,
  },
  {
    name: "session.status {idle} → agent_idle",
    payload: {
      type: "session.status",
      properties: { sessionID: SID, status: { type: "idle" } },
      cwd: CWD,
    },
    eventType: "agent_idle",
    status: "idle",
    notifyDefault: true,
  },
  {
    name: "session.status {retry} → session_active",
    payload: {
      type: "session.status",
      properties: { sessionID: SID, status: { type: "retry", attempt: 2 } },
      cwd: CWD,
    },
    eventType: "session_active",
    status: "running",
    notifyDefault: false,
  },
  {
    name: "session.idle → agent_idle",
    payload: { type: "session.idle", properties: { sessionID: SID }, cwd: CWD },
    eventType: "agent_idle",
    status: "idle",
    notifyDefault: true,
  },
  {
    name: "session.error → agent_failed",
    payload: {
      type: "session.error",
      properties: { sessionID: SID, error: { name: "ProviderAuthError" } },
      cwd: CWD,
    },
    eventType: "agent_failed",
    status: "failed",
    notifyDefault: true,
  },
  {
    // Real opencode 1.18.1 shape: type discriminator is `permission`; `patterns` +
    // `metadata.command` carry the actual command and must never be persisted.
    name: "permission.asked → approval_required",
    payload: {
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID: SID,
        permission: "bash",
        patterns: ["npm install"],
        metadata: { command: "npm install" },
      },
      cwd: CWD,
    },
    eventType: "approval_required",
    status: "waiting_for_approval",
    notifyDefault: true,
  },
  {
    name: "tool.execute.before → tool_started",
    payload: {
      type: "tool.execute.before",
      properties: { sessionID: SID, tool: "bash" },
      cwd: CWD,
    },
    eventType: "tool_started",
    status: "running",
    notifyDefault: false,
  },
  {
    name: "tool.execute.after → tool_finished",
    payload: { type: "tool.execute.after", properties: { sessionID: SID, tool: "edit" }, cwd: CWD },
    eventType: "tool_finished",
    status: "running",
    notifyDefault: false,
  },
];

describe("§9.7 → §10.1 mapping table", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const evt = await normalizeOpenCodeEvent(c.payload, OPTS);
      expect(evt.event_type).toBe(c.eventType);
      expect(evt.status).toBe(c.status);
      expect(evt.harness).toBe("opencode");
      expect(evt.source_session_id).toBe(SID);
      expect(evt.workspace.cwd).toMatch(/^h_[0-9a-f]{16}$/); // cwd always hashed
    });
  }
});

describe("session identity (§10.3)", () => {
  it("falls back to a deterministic best-effort id when none is provided", async () => {
    const payload = { type: "session.idle", properties: {}, cwd: CWD };
    const a = await normalizeOpenCodeEvent(payload, OPTS);
    const b = await normalizeOpenCodeEvent(payload, OPTS);
    expect(a.source_session_id).toMatch(/^oc_[0-9a-f]{16}$/);
    expect(a.source_session_id).toBe(b.source_session_id);
  });
});

describe("privacy invariants (§15.6)", () => {
  it("hashes the cwd and lets no raw absolute path through", async () => {
    const evt = await normalizeOpenCodeEvent(
      { type: "session.idle", properties: { sessionID: SID }, cwd: CWD },
      OPTS,
    );
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain(CWD);
    expect(serialized).not.toMatch(/\/Users\/alice/);
  });

  it("never persists the permission command/patterns (only safe discriminators)", async () => {
    const approval = await normalizeOpenCodeEvent(
      {
        type: "permission.asked",
        properties: {
          id: "per_1",
          sessionID: SID,
          permission: "bash",
          patterns: ["cat /Users/alice/.ssh/id_rsa"],
          metadata: { command: "cat /Users/alice/.ssh/id_rsa" },
        },
        cwd: CWD,
      },
      OPTS,
    );
    const serialized = JSON.stringify(approval);
    expect(serialized).not.toContain("id_rsa");
    expect(serialized).not.toContain(".ssh");
    expect(approval.body).toBe("Approval requested");
    expect(approval.metadata?.["permission_type"]).toBe("bash"); // safe discriminator kept
  });
});

describe("unmapped events reject (caught + skipped by runAgentHook)", () => {
  it("drops permission.replied (PRD's permission_replied is not a §10.1 type — not invented)", async () => {
    await expect(
      normalizeOpenCodeEvent({
        type: "permission.replied",
        properties: { sessionID: SID },
        cwd: CWD,
      }),
    ).rejects.toBeInstanceOf(OpenCodeMappingError);
  });

  it("drops a non-lifecycle bus event (message.part.updated)", async () => {
    await expect(
      normalizeOpenCodeEvent({ type: "message.part.updated", properties: {}, cwd: CWD }),
    ).rejects.toBeInstanceOf(OpenCodeMappingError);
  });

  it("rejects a payload with no string type", async () => {
    await expect(normalizeOpenCodeEvent({ properties: {}, cwd: CWD })).rejects.toBeInstanceOf(
      OpenCodeMappingError,
    );
  });
});
