/**
 * CC-NORMALIZE proof (pure logic; no HOME/network): table-driven over real-shaped
 * Claude Code hook payloads — every mapped event asserts event_type, session status,
 * §10.5 notify-default, and schema validity; plus deterministic best-effort session
 * id, typed rejection of garbled payloads, and the privacy invariant (cwd hashed).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { birdyBeepAgentEventSchema, SESSION_NAME_METADATA_KEY } from "@birdybeep/agent-core";
import { afterEach, describe, expect, it } from "vitest";

import { BIRDYBEEP_HOOK_EVENTS } from "./install";
import {
  CLAUDE_CODE_HOOK_EVENTS,
  CLAUDE_CODE_NON_HOOK_EVENTS,
  ClaudeCodeMappingError,
  claudeCodeSurface,
  isClaudeCodeHookPayload,
  normalizeClaudeCodeEvent,
} from "./normalize";
import { SESSION_NAME_MAX_CHARS } from "./session-names";

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
  session_ended: false, // lifecycle marker — never beeps
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
  {
    name: "SessionEnd",
    payload: { ...base, hook_event_name: "SessionEnd", reason: "clear" },
    eventType: "session_ended",
    status: "completed", // terminal → settles the session into the "ended" bucket
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

  it("SessionEnd carries the reason into metadata and is a non-notifying terminal event", async () => {
    const ev = await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "SessionEnd", reason: "logout" },
      DET,
    );
    expect(ev.event_type).toBe("session_ended");
    expect(ev.status).toBe("completed");
    expect((ev.metadata as Record<string, unknown>)["reason"]).toBe("logout");
    expect(NOTIFY_DEFAULT[ev.event_type]).toBe(false); // closing a session must never beep
  });

  it("SessionEnd defaults the reason to 'other' when the hook omits it", async () => {
    const ev = await normalizeClaudeCodeEvent({ ...base, hook_event_name: "SessionEnd" }, DET);
    expect((ev.metadata as Record<string, unknown>)["reason"]).toBe("other");
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

  // birdybeep-agent-gcgp.1: Cursor desktop's Claude bridge runs `birdybeep hook claude` with
  // Cursor's own LOWERCASE step names. This normalizer must keep rejecting them (they are not
  // Claude Code events) — and `isClaudeCodeHookPayload` must say so, which is what lets the CLI
  // route them to the Cursor adapter instead of dropping them with a silent exit 0.
  it("rejects Cursor's lowercase step names and does not claim them as Claude Code's", async () => {
    for (const name of ["sessionStart", "stop", "sessionEnd", "preToolUse", "beforeSubmitPrompt"]) {
      const payload = { ...base, hook_event_name: name, cursor_version: "3.14.27" };
      await expect(
        normalizeClaudeCodeEvent(payload),
        `expected ${name} to reject`,
      ).rejects.toBeInstanceOf(ClaudeCodeMappingError);
      expect(isClaudeCodeHookPayload(payload), `${name} is not a Claude Code event`).toBe(false);
    }
  });
});

describe("isClaudeCodeHookPayload (gcgp.1)", () => {
  it("accepts every hook event Claude Code fires, including ones we don't map", () => {
    for (const name of CLAUDE_CODE_HOOK_EVENTS) {
      expect(isClaudeCodeHookPayload({ ...base, hook_event_name: name }), name).toBe(true);
    }
    // The events the installer registers are a subset of what Claude Code can fire.
    for (const name of BIRDYBEEP_HOOK_EVENTS) expect(CLAUDE_CODE_HOOK_EVENTS).toContain(name);
    // Unmapped-but-real events are recognized, so they stay a QUIET skip.
    expect(isClaudeCodeHookPayload({ ...base, hook_event_name: "PreCompact" })).toBe(true);
  });

  it("rejects non-payloads and unknown names", () => {
    for (const value of [undefined, null, 42, "Stop", [], {}, { hook_event_name: 7 }]) {
      expect(isClaudeCodeHookPayload(value)).toBe(false);
    }
    expect(isClaudeCodeHookPayload({ ...base, hook_event_name: "Bogus" })).toBe(false);
  });

  // birdybeep-agent-gcgp.12: the §5 reconciliation note defers TaskCreated/TaskCompleted —
  // they are events Claude Code fires whose §10.1 targets don't exist yet. Deferred is not
  // foreign: leaving them out made every fire of a hand-wired Task hook a per-fire error.
  it("recognizes the events §5 defers, so they stay a quiet skip and never error", async () => {
    for (const name of ["TaskCreated", "TaskCompleted"]) {
      const payload = { ...base, hook_event_name: name };
      expect(isClaudeCodeHookPayload(payload), `${name} is a real Claude Code event`).toBe(true);
      // Still unmapped — recognized only means "don't shout", not "invent an event type".
      await expect(normalizeClaudeCodeEvent(payload), name).rejects.toBeInstanceOf(
        ClaudeCodeMappingError,
      );
    }
  });

  // §5 states SubagentStart "is not a Claude Code hook event"; it is Codex's (§6). So a
  // SubagentStart payload at `hook claude` is a genuine foreign payload, not a quiet skip.
  it("does not claim SubagentStart, which §5 documents as not a Claude Code event", () => {
    expect(CLAUDE_CODE_NON_HOOK_EVENTS).toContain("SubagentStart");
    expect(isClaudeCodeHookPayload({ ...base, hook_event_name: "SubagentStart" })).toBe(false);
  });
});

/**
 * The drift guard (birdybeep-agent-gcgp.12). `CLAUDE_CODE_HOOK_EVENTS` decides whether an
 * unmapped fire is silent or an error, so an event name added to the spec but not to the list
 * silently becomes a per-fire failure. Read §5 back and require every hook event name it
 * mentions to be classified — recognized, or explicitly documented as not an event.
 */
describe("CLAUDE_CODE_HOOK_EVENTS stays in sync with docs/SPEC.md §5", () => {
  function specSection5(): string {
    const spec = readFileSync(new URL("../../../docs/SPEC.md", import.meta.url), "utf8");
    const start = spec.indexOf("## 5. Claude Code mapping");
    const end = spec.indexOf("## 6.", start);
    expect(start, "SPEC.md §5 heading not found").toBeGreaterThan(-1);
    expect(end, "SPEC.md §6 heading not found").toBeGreaterThan(start);
    return spec.slice(start, end);
  }

  it("classifies every event name §5 mentions", () => {
    const mentioned = new Set<string>();
    // §5 backticks every identifier; hook event names are the PascalCase ones (§10.1 event
    // types and payload fields are snake_case, so they don't match).
    for (const [, code] of specSection5().matchAll(/`([^`]+)`/g)) {
      if (/^[A-Z][A-Za-z]+$/.test(code!)) mentioned.add(code!);
    }
    expect(
      mentioned.size,
      "extracted no event names from §5 — did its formatting change?",
    ).toBeGreaterThan(5);
    const classified = new Set([...CLAUDE_CODE_HOOK_EVENTS, ...CLAUDE_CODE_NON_HOOK_EVENTS]);
    const unclassified = [...mentioned].filter((name) => !classified.has(name)).sort();
    expect(
      unclassified,
      "docs/SPEC.md §5 names these events but normalize.ts classifies neither as a hook event " +
        "nor as a non-event — add them to CLAUDE_CODE_HOOK_EVENTS (deferred-but-real) or to " +
        "CLAUDE_CODE_NON_HOOK_EVENTS (not a Claude Code event)",
    ).toEqual([]);
    // The specific names that made gcgp.12 real, asserted by hand so the guard can't pass vacuously.
    for (const name of ["TaskCreated", "TaskCompleted"]) expect(mentioned).toContain(name);
  });

  it("does not classify a name as both a hook event and a non-event", () => {
    for (const name of CLAUDE_CODE_NON_HOOK_EVENTS) {
      expect(CLAUDE_CODE_HOOK_EVENTS, name).not.toContain(name);
    }
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

describe("descriptive completion push (0r6)", () => {
  const tmpDirs: string[] = [];
  function gitCheckout(name: string, head: string): string {
    const root = mkdtempSync(join(tmpdir(), "bb-cc-"));
    tmpDirs.push(root);
    const repo = join(root, name);
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), head);
    return repo;
  }
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("Stop body is the summarized last_assistant_message (first non-empty line)", async () => {
    const ev = await normalizeClaudeCodeEvent(
      {
        ...base,
        hook_event_name: "Stop",
        last_assistant_message:
          "Done — wired up the push retry logic.\n\nDetails:\n- exponential backoff\n- per-device dedupe",
      },
      DET,
    );
    expect(ev.body).toBe("Done — wired up the push retry logic.");
  });

  it("Stop body falls back to 'Turn complete' when no last_assistant_message", async () => {
    const ev = await normalizeClaudeCodeEvent({ ...base, hook_event_name: "Stop" }, DET);
    expect(ev.body).toBe("Turn complete");
  });

  it("leads the title with '<repo> · <branch>' and populates workspace labels for a checkout", async () => {
    const repo = gitCheckout("myapp", "ref: refs/heads/main\n");
    const ev = await normalizeClaudeCodeEvent(
      { ...base, cwd: repo, hook_event_name: "Stop", last_assistant_message: "All green." },
      DET,
    );
    expect(ev.title).toBe("myapp · main — Claude Code finished");
    expect(ev.body).toBe("All green.");
    expect(ev.workspace.repo_name).toBe("myapp");
    expect(ev.workspace.branch).toBe("main");
    // cwd is still hashed even though we surface repo/branch labels.
    expect(ev.workspace.cwd).toMatch(/^h_[0-9a-f]{16}$/);
    expect(JSON.stringify(ev)).not.toContain(repo);
  });

  it("prefixes every notifying event's title, not just Stop", async () => {
    const repo = gitCheckout("api", "ref: refs/heads/main\n");
    const ev = await normalizeClaudeCodeEvent(
      {
        ...base,
        cwd: repo,
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        message: "Allow Bash?",
      },
      DET,
    );
    expect(ev.title).toBe("api · main — Claude Code needs approval");
  });

  it("leaves the title as the plain action (no repo labels) outside a checkout", async () => {
    // RAW_CWD is a non-existent path → no enclosing .git → no prefix.
    const ev = await normalizeClaudeCodeEvent({ ...base, hook_event_name: "Stop" }, DET);
    expect(ev.title).toBe("Claude Code finished");
    expect(ev.workspace.repo_name).toBeUndefined();
    expect(ev.workspace.branch).toBeUndefined();
  });

  it("omits the branch on a detached HEAD", async () => {
    const repo = gitCheckout("det", "0000000000000000000000000000000000000000\n");
    const ev = await normalizeClaudeCodeEvent({ ...base, cwd: repo, hook_event_name: "Stop" }, DET);
    expect(ev.title).toBe(`${basename(repo)} — Claude Code finished`);
    expect(ev.workspace.repo_name).toBe(basename(repo));
    expect(ev.workspace.branch).toBeUndefined();
  });
});

/**
 * sv1: when the user has NAMED the session (Claude Code `--name` / `/rename`), the push
 * title should say WHICH session wants them. `session_title` is exposed ONLY in the
 * SessionStart hook payload (never in Stop), and hooks are separate processes — so the
 * name is captured at SessionStart, persisted keyed by session_id, and read back when a
 * later event composes its title. Precedence: session name → repo · branch → repo → plain.
 */
describe("session name in the push title (sv1)", () => {
  const tmpDirs: string[] = [];
  function sandboxDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "bb-sv1-"));
    tmpDirs.push(dir);
    return dir;
  }
  function gitCheckout(name: string, head: string): string {
    const root = sandboxDir();
    const repo = join(root, name);
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), head);
    return repo;
  }
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("SessionStart persists session_title; a later Stop leads the title with the NAME, not repo · branch", async () => {
    const stateDir = sandboxDir();
    const repo = gitCheckout("myapp", "ref: refs/heads/main\n");
    const opts = { ...DET, sessionStateDir: stateDir };

    // 1. SessionStart carries the name (the ONLY hook that does).
    await normalizeClaudeCodeEvent(
      {
        ...base,
        cwd: repo,
        hook_event_name: "SessionStart",
        source: "startup",
        session_title: "billing refactor",
      },
      opts,
    );

    // 2. A LATER Stop — no session_title in this payload at all — still knows the name.
    const stop = await normalizeClaudeCodeEvent(
      { ...base, cwd: repo, hook_event_name: "Stop", last_assistant_message: "All green." },
      opts,
    );
    expect(stop.title).toBe("billing refactor — Claude Code finished");
    // The repo/branch workspace labels are unaffected — only the TITLE lead changes.
    expect(stop.workspace.repo_name).toBe("myapp");
    expect(stop.workspace.branch).toBe("main");
  });

  it("no session name set → behavior is EXACTLY 0r6 (repo · branch leads)", async () => {
    const stateDir = sandboxDir();
    const repo = gitCheckout("myapp", "ref: refs/heads/main\n");
    const opts = { ...DET, sessionStateDir: stateDir };
    // SessionStart WITHOUT a session_title must persist nothing.
    await normalizeClaudeCodeEvent(
      { ...base, cwd: repo, hook_event_name: "SessionStart", source: "startup" },
      opts,
    );
    const stop = await normalizeClaudeCodeEvent(
      { ...base, cwd: repo, hook_event_name: "Stop" },
      opts,
    );
    expect(stop.title).toBe("myapp · main — Claude Code finished");
  });

  it("the name leads even outside a git checkout (name → repo · branch → repo → plain)", async () => {
    const stateDir = sandboxDir();
    const opts = { ...DET, sessionStateDir: stateDir };
    await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "SessionStart", session_title: "scratch pad" },
      opts,
    );
    // RAW_CWD is not a checkout → 0r6 would give a bare action; the name still leads.
    const stop = await normalizeClaudeCodeEvent({ ...base, hook_event_name: "Stop" }, opts);
    expect(stop.title).toBe("scratch pad — Claude Code finished");
  });

  it("names are per-session: another session_id keeps its own repo · branch title", async () => {
    const stateDir = sandboxDir();
    const repo = gitCheckout("myapp", "ref: refs/heads/main\n");
    const opts = { ...DET, sessionStateDir: stateDir };
    await normalizeClaudeCodeEvent(
      {
        ...base,
        cwd: repo,
        hook_event_name: "SessionStart",
        session_title: "billing refactor",
      },
      opts,
    );
    const other = await normalizeClaudeCodeEvent(
      { ...base, session_id: "sess_cc_OTHER", cwd: repo, hook_event_name: "Stop" },
      opts,
    );
    expect(other.title).toBe("myapp · main — Claude Code finished");
  });

  it("SessionEnd cleans the name up — no state leaks past the session's life", async () => {
    const stateDir = sandboxDir();
    const repo = gitCheckout("myapp", "ref: refs/heads/main\n");
    const opts = { ...DET, sessionStateDir: stateDir };
    await normalizeClaudeCodeEvent(
      { ...base, cwd: repo, hook_event_name: "SessionStart", session_title: "billing refactor" },
      opts,
    );
    expect(readdirSync(stateDir).length).toBe(1);

    // SessionEnd still SHOWS the name (it is the last word on this session)…
    const ended = await normalizeClaudeCodeEvent(
      { ...base, cwd: repo, hook_event_name: "SessionEnd", reason: "clear" },
      opts,
    );
    expect(ended.title).toBe("billing refactor — Claude Code session ended");
    // …but leaves nothing behind on disk.
    expect(readdirSync(stateDir).length).toBe(0);
  });

  it("an expired name (TTL) is swept and the title falls back to repo · branch", async () => {
    const stateDir = sandboxDir();
    const repo = gitCheckout("myapp", "ref: refs/heads/main\n");
    let clock = 1_000_000;
    const opts = {
      ...DET,
      sessionStateDir: stateDir,
      sessionStateTtlMs: 60_000,
      sessionStateNow: () => clock,
    };
    await normalizeClaudeCodeEvent(
      { ...base, cwd: repo, hook_event_name: "SessionStart", session_title: "stale session" },
      opts,
    );
    clock += 60_001; // past the TTL
    const stop = await normalizeClaudeCodeEvent(
      { ...base, cwd: repo, hook_event_name: "Stop" },
      opts,
    );
    expect(stop.title).toBe("myapp · main — Claude Code finished");
    expect(readdirSync(stateDir).length).toBe(0); // expired entry pruned, no unbounded growth
  });

  it("writes NO state when Claude Code gives no session_id (best-effort ids can't correlate)", async () => {
    const stateDir = sandboxDir();
    const opts = { ...DET, sessionStateDir: stateDir };
    const ev = await normalizeClaudeCodeEvent(
      {
        transcript_path: "/t.jsonl",
        cwd: RAW_CWD,
        hook_event_name: "SessionStart",
        session_title: "unkeyed",
      },
      opts,
    );
    expect(ev.source_session_id).toMatch(/^cc_[0-9a-f]{16}$/);
    // The best-effort id is derived per-event (it seeds on hook_event_name), so it could
    // never be looked up by a later Stop — persisting under it would only leak junk files.
    expect(existsSync(stateDir) ? readdirSync(stateDir).length : 0).toBe(0);
  });

  it("is fail-soft: an unusable state dir never throws into the hook (falls back to 0r6)", async () => {
    // A FILE where the state dir should be → every fs op on it fails (ENOTDIR).
    const root = sandboxDir();
    const notADir = join(root, "blocked");
    writeFileSync(notADir, "i am a file, not a directory");
    const repo = gitCheckout("myapp", "ref: refs/heads/main\n");
    const opts = { ...DET, sessionStateDir: notADir };

    await expect(
      normalizeClaudeCodeEvent(
        { ...base, cwd: repo, hook_event_name: "SessionStart", session_title: "doomed" },
        opts,
      ),
    ).resolves.toBeDefined(); // must NOT reject — the hook keeps working

    const stop = await normalizeClaudeCodeEvent(
      { ...base, cwd: repo, hook_event_name: "Stop" },
      opts,
    );
    expect(stop.title).toBe("myapp · main — Claude Code finished"); // graceful 0r6 fallback
  });
});

/**
 * 991: the session name is ALSO reported as a discrete `metadata.session_name`, so the
 * server can compose a `titleFormat="session_name"` push title instead of having to
 * reverse-engineer it out of the adapter's title prefix. Rides the §10.2 metadata catchall
 * (no wire-schema change); absent when the session is unnamed, so the server degrades to
 * the adapter title. The field is cleaned by exactly the same pipeline as the title lead.
 */
describe("metadata.session_name (991)", () => {
  const tmpDirs: string[] = [];
  function sandboxDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "bb-991-"));
    tmpDirs.push(dir);
    return dir;
  }
  function gitCheckout(name: string, head: string): string {
    const root = sandboxDir();
    const repo = join(root, name);
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), head);
    return repo;
  }
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** The exact spelling the product Worker reads out of the catchall — pinned, not inferred. */
  it("uses the exact cross-repo key 'session_name'", () => {
    expect(SESSION_NAME_METADATA_KEY).toBe("session_name");
  });

  it("SessionStart emits the captured name; a LATER Stop still carries it", async () => {
    const opts = { ...DET, sessionStateDir: sandboxDir() };
    const started = await normalizeClaudeCodeEvent(
      {
        ...base,
        hook_event_name: "SessionStart",
        source: "startup",
        session_title: "auth refactor",
      },
      opts,
    );
    expect(started.metadata?.["session_name"]).toBe("auth refactor");

    // The later hook payload has no session_title at all — the store supplies it.
    const stop = await normalizeClaudeCodeEvent({ ...base, hook_event_name: "Stop" }, opts);
    expect(stop.metadata?.["session_name"]).toBe("auth refactor");
    // …and the sv1 title lead is unchanged: the field is ADDITIONAL, not a replacement.
    expect(stop.title).toBe("auth refactor — Claude Code finished");
  });

  it("is ABSENT (not empty) for an unnamed session — the server degrades to the adapter title", async () => {
    const opts = { ...DET, sessionStateDir: sandboxDir() };
    await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "SessionStart", source: "startup" },
      opts,
    );
    const stop = await normalizeClaudeCodeEvent({ ...base, hook_event_name: "Stop" }, opts);
    expect(stop.metadata?.["session_name"]).toBeUndefined();
    expect(Object.keys(stop.metadata ?? {})).not.toContain("session_name");
  });

  it("rides ALONGSIDE the event's own metadata (never clobbers it)", async () => {
    const opts = { ...DET, sessionStateDir: sandboxDir() };
    await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "SessionStart", session_title: "auth refactor" },
      opts,
    );
    const approval = await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "PermissionRequest", tool_name: "Bash" },
      opts,
    );
    expect(approval.metadata?.["tool"]).toBe("Bash");
    expect(approval.metadata?.["session_name"]).toBe("auth refactor");
  });

  it("SessionEnd carries the name (its last word) and StopFailure keeps its error_type", async () => {
    const opts = { ...DET, sessionStateDir: sandboxDir() };
    await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "SessionStart", session_title: "auth refactor" },
      opts,
    );
    const failed = await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "StopFailure", error_type: "rate_limit" },
      opts,
    );
    expect(failed.metadata).toMatchObject({
      error_type: "rate_limit",
      session_name: "auth refactor",
    });
    const ended = await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "SessionEnd", reason: "clear" },
      opts,
    );
    expect(ended.metadata?.["session_name"]).toBe("auth refactor");
  });

  it("does NOT leak one session's name onto another session's events", async () => {
    const opts = { ...DET, sessionStateDir: sandboxDir() };
    await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "SessionStart", session_title: "auth refactor" },
      opts,
    );
    const other = await normalizeClaudeCodeEvent(
      { ...base, session_id: "sess_cc_OTHER", hook_event_name: "Stop" },
      opts,
    );
    expect(other.metadata?.["session_name"]).toBeUndefined();
  });

  it("PRIVACY: an absolute path typed into a session name is HASHED in the metadata, exactly as in the title", async () => {
    const opts = { ...DET, sessionStateDir: sandboxDir() };
    const named = `fix ${RAW_CWD}/src`;
    await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "SessionStart", session_title: named },
      opts,
    );
    const stop = await normalizeClaudeCodeEvent({ ...base, hook_event_name: "Stop" }, opts);
    const emitted = stop.metadata?.["session_name"] as string;
    expect(emitted).not.toContain(RAW_CWD);
    expect(emitted).toMatch(/^fix h_[0-9a-f]{16}$/);
    // The title lead gets the same treatment — it is hashed there too (the token itself
    // differs only because the title appends the action, and the scrubber deliberately
    // over-absorbs trailing prose into the hashed run rather than risk leaking a fragment).
    expect(stop.title).toMatch(/^fix h_[0-9a-f]{16}$/);
    expect(JSON.stringify(stop)).not.toContain(RAW_CWD);
    expect(JSON.stringify(stop)).not.toContain("/Users/");
  });

  it("PRIVACY: a secret STRADDLING the 120-char name cap never reaches the wire (PR #45 review)", async () => {
    // The reproduced defect: cleanSessionName capped BEFORE redacting, so the cut left
    // `ghp_a1b2c3d4e5` — too short for the PAT pattern to match on the way out — readable in
    // BOTH the metadata field and the title lead it mirrors.
    const opts = { ...DET, sessionStateDir: sandboxDir() };
    const token = `ghp_${"a1b2c3d4e5".repeat(3)}${"z".repeat(6)}`;
    const padding = "word ".repeat(21); // 105 chars → the cut lands inside the token
    await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "SessionStart", session_title: `${padding}${token}` },
      opts,
    );
    const stop = await normalizeClaudeCodeEvent({ ...base, hook_event_name: "Stop" }, opts);

    const emitted = stop.metadata?.["session_name"] as string;
    expect(emitted).toContain("[redacted]");
    for (const surface of [emitted, stop.title, JSON.stringify(stop)]) {
      expect(surface).not.toContain("ghp_"); // no prefix, anywhere
      expect(surface).not.toContain(token.slice(0, 14)); // nor the head the cut used to leave
      expect(surface).not.toContain(token);
    }
  });

  it("PRIVACY: a secret typed into a session name is REDACTED in the metadata", async () => {
    const opts = { ...DET, sessionStateDir: sandboxDir() };
    const secret = `ghp_${"a1b2c3d4e5".repeat(3)}`;
    await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "SessionStart", session_title: `debug ${secret}` },
      opts,
    );
    const stop = await normalizeClaudeCodeEvent({ ...base, hook_event_name: "Stop" }, opts);
    expect(stop.metadata?.["session_name"]).toBe("debug [redacted]");
    expect(JSON.stringify(stop)).not.toContain(secret);
  });

  it("is length-bounded (a pathological /rename can't bloat the event)", async () => {
    const opts = { ...DET, sessionStateDir: sandboxDir() };
    await normalizeClaudeCodeEvent(
      { ...base, hook_event_name: "SessionStart", session_title: "n".repeat(5000) },
      opts,
    );
    const stop = await normalizeClaudeCodeEvent({ ...base, hook_event_name: "Stop" }, opts);
    // cleanSessionName caps at 120 before the normalizer's own 500-char metadata cap.
    expect((stop.metadata?.["session_name"] as string).length).toBe(SESSION_NAME_MAX_CHARS);
  });

  it("the repo · branch fallback does NOT masquerade as a session name", async () => {
    const opts = { ...DET, sessionStateDir: sandboxDir() };
    const repo = gitCheckout("myapp", "ref: refs/heads/main\n");
    const stop = await normalizeClaudeCodeEvent(
      { ...base, cwd: repo, hook_event_name: "Stop" },
      opts,
    );
    // The title still leads with repo · branch (0r6) — but that is NOT a name, so the
    // server must not be told it is one (it has repo_name/branch for that format).
    expect(stop.title).toBe("myapp · main — Claude Code finished");
    expect(stop.metadata?.["session_name"]).toBeUndefined();
  });
});

/**
 * birdybeep-agent-gcgp.7 — `harness_version` names WHICH Claude Code engine fired the hook.
 * The values below are the ones actually observed in a live hook child's environment on
 * macOS 2026-08-16: the terminal CLI at `~/.local/bin/claude` reported 2.1.227 while the
 * desktop app's bundled engine reported 2.1.229 — same machine, same minute, two channels.
 * Only one of them is on PATH, which is why a `claude --version` probe cannot answer this.
 */
describe("harness_version identifies the engine that fired the hook (gcgp.7)", () => {
  const tmpDirs: string[] = [];
  function opts(env: NodeJS.ProcessEnv) {
    const dir = mkdtempSync(join(tmpdir(), "bb-hv-"));
    tmpDirs.push(dir);
    return { ...DET, sessionStateDir: dir, env };
  }
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const start = { ...base, hook_event_name: "SessionStart", source: "startup" };
  const TERMINAL = { AI_AGENT: "claude-code_2-1-227_harness" };
  const DESKTOP = {
    CLAUDE_CODE_EXECPATH:
      "/Users/alice/Library/Application Support/Claude/claude-code/2.1.229/claude.app/Contents/MacOS/claude",
    AI_AGENT: "claude-code_2-1-229_agent",
  };

  it("reads the terminal CLI version out of AI_AGENT", async () => {
    const ev = await normalizeClaudeCodeEvent(start, opts(TERMINAL));
    expect(ev.harness_version).toBe("2.1.227");
  });

  it("reads the desktop-bundled engine version out of CLAUDE_CODE_EXECPATH", async () => {
    const ev = await normalizeClaudeCodeEvent(start, opts(DESKTOP));
    expect(ev.harness_version).toBe("2.1.229");
    // EXECPATH is an absolute path: only the version substring is read, never the path.
    expect(JSON.stringify(ev)).not.toContain("Application Support");
  });

  it("tells the two update channels apart on one machine", async () => {
    const terminal = await normalizeClaudeCodeEvent(start, opts(TERMINAL));
    const desktop = await normalizeClaudeCodeEvent(start, opts(DESKTOP));
    expect(terminal.harness_version).not.toBe(desktop.harness_version);
  });

  it("rides every mapped event, not just SessionStart", async () => {
    for (const c of cases) {
      const ev = await normalizeClaudeCodeEvent(c.payload, opts(TERMINAL));
      expect(ev.harness_version, c.name).toBe("2.1.227");
    }
  });

  it("is omitted, never guessed, when the engine reports nothing", async () => {
    const ev = await normalizeClaudeCodeEvent(start, opts({}));
    expect(ev.harness_version).toBeUndefined();
    expect(Object.keys(ev)).not.toContain("harness_version");
  });

  it("ignores an AI_AGENT another tool set (the name is generic; the prefix is required)", async () => {
    const ev = await normalizeClaudeCodeEvent(start, opts({ AI_AGENT: "some-other_9-9-9_x" }));
    expect(ev.harness_version).toBeUndefined();
  });

  it("forwards no part of a junk/hostile EXECPATH", async () => {
    const ev = await normalizeClaudeCodeEvent(
      start,
      opts({ AI_AGENT: "claude-code_2-1-227_x", CLAUDE_CODE_EXECPATH: "/tmp/evil; rm -rf /" }),
    );
    // No version-shaped segment in EXECPATH → falls through to AI_AGENT; the path never leaks.
    expect(ev.harness_version).toBe("2.1.227");
    expect(JSON.stringify(ev)).not.toContain("rm -rf");
  });
});

/**
 * gcgp.6: which SURFACE fired, for the local observed-builds tally. Never enters the event —
 * asserted here alongside the version because both come from the same hook-child environment.
 */
describe("claudeCodeSurface", () => {
  it("reads the desktop app from the entrypoint it exports", () => {
    expect(claudeCodeSurface({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" })).toBe("desktop");
  });

  it("reads the desktop app from the managed engine path when the entrypoint is absent", () => {
    expect(
      claudeCodeSurface({
        CLAUDE_CODE_EXECPATH:
          "/Users/d/Library/Application Support/Claude/claude-code/2.1.229/claude.app/Contents/MacOS/claude",
      }),
    ).toBe("desktop");
  });

  it("reads the terminal CLI, and never claims desktop without positive evidence", () => {
    expect(claudeCodeSurface({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe("terminal");
    expect(claudeCodeSurface({})).toBe("terminal");
    expect(claudeCodeSurface({ CLAUDE_CODE_EXECPATH: "/Users/d/.local/bin/claude" })).toBe(
      "terminal",
    );
  });
});
