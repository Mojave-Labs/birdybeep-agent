/**
 * CC-NORMALIZE proof (pure logic; no HOME/network): table-driven over real-shaped
 * Claude Code hook payloads — every mapped event asserts event_type, session status,
 * §10.5 notify-default, and schema validity; plus deterministic best-effort session
 * id, typed rejection of garbled payloads, and the privacy invariant (cwd hashed).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { birdyBeepAgentEventSchema } from "@birdybeep/agent-core";
import { afterEach, describe, expect, it } from "vitest";

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
