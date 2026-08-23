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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isOpenCodeEventPayload,
  normalizeOpenCodeEvent,
  OPENCODE_EVENT_TYPES,
  OpenCodeMappingError,
} from "./normalize";
import { FORWARDED_BUS_EVENTS } from "./plugin";

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

/**
 * 991 audit guard: OpenCode must NOT report a `metadata.session_name`. The Session object on
 * session.created/updated carries a conversation-DERIVED `title` (OpenCode writes it from the
 * session's own messages — it is not a name the user typed), so forwarding it would leak
 * summarized prompt text and would only be present on the two non-beeping events that carry
 * `info` at all. The server degrades gracefully when the field is absent; that is the correct
 * outcome here, and this test keeps a future "just pass info.title through" from undoing it.
 */
describe("no session_name from OpenCode (991)", () => {
  const PROMPT_TITLE = "Refactor the billing webhook retry logic";

  it("session.updated does NOT forward the auto-generated session title", async () => {
    const ev = await normalizeOpenCodeEvent(
      {
        type: "session.updated",
        properties: { info: { id: SID, title: PROMPT_TITLE, directory: CWD } },
        cwd: CWD,
      },
      OPTS,
    );
    expect(ev.metadata?.["session_name"]).toBeUndefined();
    expect(JSON.stringify(ev)).not.toContain(PROMPT_TITLE);
    expect(ev.source_session_id).toBe(SID); // the id IS used — as an id, never as a name
  });

  it("the beeping events carry no session_name either", async () => {
    for (const payload of [
      { type: "session.idle", properties: { sessionID: SID }, cwd: CWD },
      { type: "permission.asked", properties: { sessionID: SID, permission: "bash" }, cwd: CWD },
    ]) {
      const ev = await normalizeOpenCodeEvent(payload, OPTS);
      expect(ev.metadata?.["session_name"]).toBeUndefined();
    }
  });
});

/**
 * birdybeep-agent-gcgp.14 — an unmappable payload at `birdybeep hook opencode` returned
 * `skipped` at exit 0 with no output, so a fire from something other than the BirdyBeep plugin
 * vanished. Nothing here is a harness-defined name: OpenCode writes no hook command, so this
 * command is invoked only by `plugin.ts`, and the recognized set is its forward list plus the
 * names older installed plugins forwarded.
 */
describe("isOpenCodeEventPayload — foreign payloads are recognized as foreign (gcgp.14)", () => {
  it("accepts every real envelope this adapter maps", () => {
    for (const { name, payload } of CASES) {
      expect(isOpenCodeEventPayload(payload), name).toBe(true);
    }
  });

  it("covers everything the shipped plugin forwards — a gap would error on every fire", () => {
    for (const event of FORWARDED_BUS_EVENTS) expect(OPENCODE_EVENT_TYPES).toContain(event);
    expect(OPENCODE_EVENT_TYPES).toContain("tool.execute.before"); // the named tool hooks
    expect(OPENCODE_EVENT_TYPES).toContain("tool.execute.after");
  });

  it("accepts what an OLDER installed plugin still forwards", () => {
    // A user can be running a plugin from a previous release; a real event from it stays a
    // quiet skip rather than becoming a per-fire error.
    expect(isOpenCodeEventPayload({ type: "permission.replied", properties: {} })).toBe(true);
    expect(isOpenCodeEventPayload({ type: "permission.updated", properties: {} })).toBe(true);
  });

  it("rejects the real payloads of every OTHER harness", () => {
    expect(
      isOpenCodeEventPayload({
        hook_event_name: "sessionStart",
        cursor_version: "3.14.27",
        workspace_roots: [CWD],
      }),
    ).toBe(false);
    expect(isOpenCodeEventPayload({ hook_event_name: "SessionStart", session_id: SID })).toBe(
      false,
    );
    expect(isOpenCodeEventPayload({ type: "agent-turn-complete", "thread-id": "t" })).toBe(false);
    expect(isOpenCodeEventPayload({ sessionId: SID, timestamp: 1, cwd: CWD })).toBe(false);
  });

  it("rejects a non-object, and an OpenCode bus event the plugin never forwards", () => {
    for (const value of [null, undefined, 7, "session.idle", [], {}]) {
      expect(isOpenCodeEventPayload(value)).toBe(false);
    }
    // message.part.updated is real OpenCode traffic, but the plugin filters it out before the
    // hook — so seeing one here means something else built this envelope.
    expect(isOpenCodeEventPayload({ type: "message.part.updated", properties: {} })).toBe(false);
  });
});

/**
 * birdybeep-agent-2ep — OpenCode was the other adapter with no repo label, so parallel sessions
 * produced beeps you could not tell apart. Derived from cwd only.
 *
 * NO body summary here, deliberately: OpenCode's only conversation-derived text is
 * `properties.info`, which is composed from the USER's own messages (not the agent's closing
 * line) AND is absent from the events that actually beep. There is nothing safe and useful to
 * summarize, so the generic copy stands. That "nothing available" is the finding, not an omission.
 */
describe("title leads with the checkout (2ep)", () => {
  const tmpDirs: string[] = [];
  function gitCheckout(name: string, head: string): string {
    const root = mkdtempSync(join(tmpdir(), "bb-oc-2ep-"));
    tmpDirs.push(root);
    const repo = join(root, name);
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), head);
    return repo;
  }
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("leads with '<repo> · <branch>'", async () => {
    const repo = gitCheckout("billing", "ref: refs/heads/main\n");
    const evt = await normalizeOpenCodeEvent(
      { type: "session.idle", properties: { sessionID: "s1" }, cwd: repo },
      OPTS,
    );
    expect(evt.title).toBe("billing · main — OpenCode is waiting");
  });

  it("keeps the plain title outside a checkout", async () => {
    const evt = await normalizeOpenCodeEvent(
      { type: "session.idle", properties: { sessionID: "s1" }, cwd: "/tmp/not-a-repo" },
      OPTS,
    );
    expect(evt.title).toBe("OpenCode is waiting");
  });
});
