/**
 * Claude Code event mapping (§9.5 → §10.1). Pure: turns a raw Claude Code hook
 * payload (keyed by hook_event_name) into a draft BirdyBeep event, then runs it
 * through agent-core's shared normalizer (path hashing, secret redaction, body
 * truncation, size cap, schema validation) — never re-implementing those rules.
 *
 * Mapping (see docs/SPEC.md §9.5 reconciliation):
 *   SessionStart                      → session_started / session_resumed (by source)
 *   Notification {permission_prompt}  → approval_required
 *   Notification {idle_prompt}        → agent_idle
 *   Notification {other}              → needs_input
 *   PermissionRequest                 → approval_required (deduped w/ permission_prompt at delivery)
 *   Stop                              → agent_completed
 *   StopFailure                       → agent_failed (error_type carried into metadata)
 *   SubagentStop                      → subagent_completed
 *   SessionEnd                        → session_ended (terminal, non-notifying; reason in metadata)
 * SubagentStart and TaskCreated/TaskCompleted are out of scope here (see SPEC §9.5).
 */
import { createHash } from "node:crypto";

import {
  type BirdyBeepAgentEvent,
  detectRepoContext,
  getMachineIdentity,
  normalizeEvent,
  type NormalizeOptions,
  type ObservedSurfaceKind,
  repoLabel,
  sanitizeHarnessVersion,
  SESSION_NAME_METADATA_KEY,
  summarizeLastMessage,
} from "@birdybeep/agent-core";

import { cleanSessionName, SessionNameStore } from "./session-names";

/**
 * Options for {@link normalizeClaudeCodeEvent}. Extends the shared normalizer options with
 * the sv1 session-name store injection points — all optional; tests pass a sandbox dir/clock,
 * production uses the real defaults (state under the user data dir).
 */
export interface ClaudeCodeNormalizeOptions extends NormalizeOptions {
  /** Session-name state dir (default `<dataDir>/claude-code/session-names`). Tests override. */
  sessionStateDir?: string;
  /** Session-name TTL in ms (default 7d). Tests override to exercise expiry. */
  sessionStateTtlMs?: number;
  /** Injectable clock (ms) for the session-name store (default wall clock). Tests override. */
  sessionStateNow?: () => number;
  /** Environment the engine exported into this hook (default `process.env`). Tests override. */
  env?: NodeJS.ProcessEnv;
}

/** Thrown for an unknown/garbled Claude Code hook payload (never a malformed event). */
export class ClaudeCodeMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeMappingError";
  }
}

interface MappedEvent {
  eventType: string;
  status: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Every hook event name Claude Code itself fires — deliberately a SUPERSET of the events the
 * installer registers (`BIRDYBEEP_HOOK_EVENTS`), because being *unmapped* is not the same as
 * being *foreign*. {@link isClaudeCodeHookPayload} draws that line: a real Claude Code event we
 * don't map is a quiet skip, while a payload that isn't Claude Code's at all is a
 * misconfiguration the CLI reports loudly (birdybeep-agent-gcgp.1). Dropping a name from this
 * list therefore turns a legitimate hook fire into an error on EVERY fire — keep it in sync
 * with `docs/SPEC.md` §5 (the `normalize.test.ts` spec guard fails if it drifts).
 *
 * Provenance for every name (birdybeep-agent-gcgp.12):
 *   - Mapped, from the §5 table: SessionStart, Notification, PermissionRequest, Stop,
 *     StopFailure, SubagentStop.
 *   - Mapped, added after §5's table was written: SessionEnd (see `BIRDYBEEP_HOOK_EVENTS`
 *     and the `case "SessionEnd"` below — the coordinated `session_ended` wire addition).
 *   - Real but DEFERRED by the §5 reconciliation note: TaskCreated, TaskCompleted. Their
 *     `task_created` / `task_completed` targets are not in the §10.1 vocabulary yet, so we
 *     don't map them — but a user who wires them must not get an error per fire.
 *   - Real but out of scope, per Cursor's shipped Claude Code bridge table (which enumerates
 *     the Claude events it translates, and which this repo relies on elsewhere for gcgp.1):
 *     PreToolUse, PostToolUse, UserPromptSubmit, PreCompact.
 *
 * `SubagentStart` is deliberately ABSENT: §5 states it "is not a Claude Code hook event", and
 * Cursor's bridge table omits it too. It IS a Codex event (§6), so a `SubagentStart` payload
 * arriving at `hook claude` is exactly the foreign-payload case worth shouting about.
 */
export const CLAUDE_CODE_HOOK_EVENTS: readonly string[] = [
  "Notification",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PreToolUse",
  "SessionEnd",
  "SessionStart",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "TaskCompleted",
  "TaskCreated",
  "UserPromptSubmit",
];

/**
 * Names `docs/SPEC.md` §5 discusses that are NOT Claude Code hook events, and why. Keeps the
 * spec guard honest: every event name §5 mentions must appear here or in
 * {@link CLAUDE_CODE_HOOK_EVENTS}, so a new name can't be added to the spec and quietly
 * ignored by the recognizer.
 */
export const CLAUDE_CODE_NON_HOOK_EVENTS: readonly string[] = [
  "SubagentStart", // §5: "is not a Claude Code hook event → not registered/mapped" (it is Codex's, §6)
];

/** Does this payload carry a hook event name Claude Code actually fires? */
export function isClaudeCodeHookPayload(input: unknown): boolean {
  const name = asRecord(input)["hook_event_name"];
  return typeof name === "string" && CLAUDE_CODE_HOOK_EVENTS.includes(name);
}

/** Deterministic best-effort session id when Claude Code provides none (§10.3). */
function bestEffortSessionId(payload: Record<string, unknown>): string {
  const seed = `${str(payload["cwd"]) ?? ""}|${str(payload["transcript_path"]) ?? ""}|${str(payload["hook_event_name"]) ?? ""}`;
  return `cc_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

// --- harness_version (birdybeep-agent-gcgp.7) ---------------------------------------
// Claude Code's hook PAYLOAD carries no version — captured live on 2.1.227 and on the
// desktop-bundled 2.1.229, every event is exactly {session_id, transcript_path, cwd,
// hook_event_name, …per-event extras}. The engine does export its identity into the hook
// child's ENVIRONMENT, which costs nothing to read and — unlike a `claude --version` probe —
// names the engine that ACTUALLY fired this hook.
//
// That distinction is the whole point of the field. Claude Code ships on two independent
// update channels on the same machine: the terminal CLI under `~/.local/bin/claude`, and the
// desktop app's bundled engine under `~/Library/Application Support/Claude/claude-code/<v>/`.
// They drift (2.1.227 vs 2.1.229 as this landed), and only ONE of them is on PATH — so a
// probe would report the terminal version for a desktop session and quietly erase the split
// this field exists to measure.
/** Desktop launcher's engine path: `…/Claude/claude-code/2.1.229/claude.app/…`. */
const EXECPATH_VERSION_RE = /[\\/]claude-code[\\/](\d+\.\d+\.\d+[\w.+-]*)[\\/]/;
/** `AI_AGENT=claude-code_2-1-229_harness` — dots are encoded as dashes in this one. */
const AI_AGENT_VERSION_RE = /^claude-code_(\d+(?:-\d+)+)_/;

/**
 * The version of the Claude Code engine that fired this hook, or undefined when it did not
 * say. Two sources, both observed in a real hook child's env:
 *   1. `CLAUDE_CODE_EXECPATH` — set by the desktop launcher; an exact dotted version sits in
 *      the path. Only the version substring is ever read; the path itself never leaves here.
 *   2. `AI_AGENT` — set by every entrypoint (`claude-code_2-1-227_harness` from the terminal
 *      CLI, `claude-code_2-1-229_…` from the desktop bundle). Dashes decode back to dots.
 * `AI_AGENT` is generically named, so the `claude-code_` prefix is required: a foreign tool's
 * value is ignored rather than reported as a Claude version. Nested harnesses are fine — the
 * innermost engine overwrites it for its own children, which is the engine we want.
 */
function claudeCodeVersion(env: NodeJS.ProcessEnv): string | undefined {
  const execPath = env["CLAUDE_CODE_EXECPATH"];
  const fromPath = typeof execPath === "string" ? EXECPATH_VERSION_RE.exec(execPath) : null;
  const fromPathVersion = sanitizeHarnessVersion(fromPath?.[1]);
  if (fromPathVersion) return fromPathVersion;

  const aiAgent = env["AI_AGENT"];
  const fromAgent = typeof aiAgent === "string" ? AI_AGENT_VERSION_RE.exec(aiAgent) : null;
  return sanitizeHarnessVersion(fromAgent?.[1]?.replace(/-/g, "."));
}

/**
 * Which SURFACE fired this hook — the terminal CLI, or the engine the Claude desktop app manages
 * (birdybeep-agent-gcgp.6). Local diagnostic metadata only: it keys the observed-builds tally and
 * never enters the event, so it is not part of the wire contract.
 *
 * Two independent signals, both observed in a real hook child's env, and desktop is only claimed
 * on positive evidence — an unrecognized entrypoint reads `terminal`, which is where the plain
 * `claude` binary lives, rather than inventing a desktop surface:
 *   1. `CLAUDE_CODE_ENTRYPOINT` — the desktop app sets `claude-desktop`; the CLI sets `cli`.
 *   2. `CLAUDE_CODE_EXECPATH` — the desktop launcher points it at its managed engine, whose path
 *      carries the `claude-code/<version>/` segment {@link EXECPATH_VERSION_RE} already matches.
 */
export function claudeCodeSurface(
  env: NodeJS.ProcessEnv = process.env,
): ObservedSurfaceKind | undefined {
  const entrypoint = env["CLAUDE_CODE_ENTRYPOINT"];
  if (typeof entrypoint === "string" && entrypoint.toLowerCase().includes("desktop")) {
    return "desktop";
  }
  const execPath = env["CLAUDE_CODE_EXECPATH"];
  if (typeof execPath === "string" && EXECPATH_VERSION_RE.test(execPath)) return "desktop";
  return "terminal";
}

/**
 * Resolve the session NAME this event carries — it leads the adapter's own title (sv1) AND is
 * reported discretely as `metadata.session_name` for server-side composition (991) — and drive
 * the name store's lifecycle. `session_title` (set via Claude Code `--name` / `/rename`) rides ONLY on the
 * SessionStart payload, so:
 *   - SessionStart: capture it and persist keyed by the REAL session_id (best-effort ids are
 *     per-event and can't be correlated by a later Stop, so we never persist under them).
 *   - SessionEnd: return the remembered name (it's the last word on this session) then forget
 *     it, so state never outlives the session.
 *   - any other event: read back the name captured at SessionStart.
 * All store ops are best-effort/fail-soft — a lookup miss simply yields undefined and the
 * caller falls back to the 0r6 repo · branch lead.
 *
 * Known limitation (documented on ticket sv1): a mid-session `/rename` AFTER SessionStart is
 * not reflected — no hook replays `session_title`, so the captured name is the SessionStart one.
 */
function resolveSessionName(
  payload: Record<string, unknown>,
  realSessionId: string | undefined,
  store: SessionNameStore,
): string | undefined {
  const event = payload["hook_event_name"];
  if (event === "SessionStart") {
    const captured = cleanSessionName(payload["session_title"]);
    if (captured && realSessionId) store.remember(realSessionId, captured);
    return captured;
  }
  if (event === "SessionEnd") {
    const existing = realSessionId ? store.lookup(realSessionId) : undefined;
    if (realSessionId) store.forget(realSessionId); // terminal — clean up state
    return existing;
  }
  return realSessionId ? store.lookup(realSessionId) : undefined;
}

function mapHookEvent(payload: Record<string, unknown>): MappedEvent {
  const name = payload["hook_event_name"];
  switch (name) {
    case "SessionStart": {
      const resumed = payload["source"] === "resume";
      return {
        eventType: resumed ? "session_resumed" : "session_started",
        status: resumed ? "running" : "starting",
        title: `Claude Code session ${resumed ? "resumed" : "started"}`,
        body: str(payload["session_title"]) ?? "",
        metadata: { source: str(payload["source"]), model: str(payload["model"]) },
      };
    }
    case "Notification": {
      const notificationType = str(payload["notification_type"]);
      const message = str(payload["message"]) ?? "";
      if (notificationType === "permission_prompt") {
        return {
          eventType: "approval_required",
          status: "waiting_for_approval",
          title: "Claude Code needs approval",
          body: message,
          metadata: { notification_type: notificationType },
        };
      }
      if (notificationType === "idle_prompt") {
        return {
          eventType: "agent_idle",
          status: "idle",
          title: "Claude Code is waiting",
          body: message,
          metadata: { notification_type: notificationType },
        };
      }
      return {
        eventType: "needs_input",
        status: "waiting_for_input",
        title: "Claude Code needs input",
        body: message,
        metadata: { notification_type: notificationType },
      };
    }
    case "PermissionRequest": {
      const tool = str(payload["tool_name"]);
      return {
        eventType: "approval_required",
        status: "waiting_for_approval",
        title: "Claude Code needs approval",
        body: tool ? `Approve ${tool}?` : "Approval requested",
        metadata: { tool },
      };
    }
    case "Stop": {
      // Claude Code hands the Stop hook the full final assistant text — use it as the
      // body so the push says WHAT finished, not just that something did (§10.2).
      const summary = summarizeLastMessage(str(payload["last_assistant_message"]));
      return {
        eventType: "agent_completed",
        status: "completed",
        title: "Claude Code finished",
        body: summary ?? "Turn complete",
        metadata: {},
      };
    }
    case "StopFailure": {
      const errorType = str(payload["error_type"]) ?? "unknown";
      return {
        eventType: "agent_failed",
        status: "failed",
        title: "Claude Code failed",
        body: `Error: ${errorType}`,
        metadata: { error_type: errorType },
      };
    }
    case "SubagentStop":
      return {
        eventType: "subagent_completed",
        status: "running",
        title: "Subagent finished",
        body: "Subtask complete",
        metadata: { agent_type: str(payload["agent_type"]) },
      };
    case "SessionEnd": {
      // The session actually closed — settle it terminal so it stops looking live. Distinct
      // from Stop (per-turn): SessionEnd fires once, at the end, and no event follows it.
      // `reason` (clear / logout / prompt_input_exit / other) is metadata, not an error.
      const reason = str(payload["reason"]) ?? "other";
      return {
        eventType: "session_ended",
        status: "completed",
        title: "Claude Code session ended",
        body: `Session ended (${reason})`,
        metadata: { reason },
      };
    }
    default:
      // Callers must not swallow this: an event name Claude Code never fires means something
      // else is driving this hook (birdybeep-agent-gcgp.1 — Cursor's Claude bridge sends its
      // own lowercase step names here). The CLI routes those and reports what it cannot.
      throw new ClaudeCodeMappingError(
        `unsupported Claude Code hook event: ${JSON.stringify(name)}`,
      );
  }
}

function buildAndNormalize(input: unknown, opts: ClaudeCodeNormalizeOptions): BirdyBeepAgentEvent {
  const payload = asRecord(input);
  if (typeof payload["hook_event_name"] !== "string") {
    throw new ClaudeCodeMappingError("payload is missing a string hook_event_name");
  }
  const mapped = mapHookEvent(payload); // throws ClaudeCodeMappingError on unknown event
  const sessionId = str(payload["session_id"]);
  const realSessionId = sessionId && sessionId.length > 0 ? sessionId : undefined;
  const machine = getMachineIdentity();
  const cwd = str(payload["cwd"]) ?? "unknown";
  // Best-effort, fail-soft: which checkout produced this event (§10.2). Populates the
  // repo/branch workspace labels AND leads the title so parallel sessions are told apart.
  const repo = detectRepoContext(cwd);
  // Title lead precedence (sv1): session NAME (via /rename, persisted at SessionStart) →
  // repo · branch → repo → plain action. The name is the most human handle, so it wins; the
  // store is fail-soft so a miss transparently degrades to the 0r6 repo · branch behavior.
  const store = new SessionNameStore({
    ...(opts.sessionStateDir !== undefined ? { dir: opts.sessionStateDir } : {}),
    ...(opts.sessionStateTtlMs !== undefined ? { ttlMs: opts.sessionStateTtlMs } : {}),
    ...(opts.sessionStateNow !== undefined ? { now: opts.sessionStateNow } : {}),
  });
  const sessionName = resolveSessionName(payload, realSessionId, store);
  const label = sessionName ?? repoLabel(repo);
  // 991: ALSO report the name as a DISCRETE metadata field, not just baked into the title.
  // The server composes the push title itself when the user picks titleFormat="session_name"
  // (§8.9), and it cannot recover a name that only exists as a title prefix. Riding the §10.2
  // metadata catchall means no wire-schema change on either side, and an absent field degrades
  // to the adapter's title — so an unnamed session (or an older/newer server) is never worse
  // off. Omitted entirely when there is no name: an empty string would out-rank nothing.
  const metadata = {
    ...mapped.metadata,
    ...(sessionName ? { [SESSION_NAME_METADATA_KEY]: sessionName } : {}),
  };
  // Which Claude Code engine fired this — terminal CLI or the desktop app's bundled build.
  // Omitted entirely when the engine didn't say: an empty string would read as a real answer.
  const harnessVersion = claudeCodeVersion(opts.env ?? process.env);
  const draft = {
    event_type: mapped.eventType,
    status: mapped.status,
    harness: "claude_code",
    ...(harnessVersion ? { harness_version: harnessVersion } : {}),
    source_session_id: realSessionId ?? bestEffortSessionId(payload),
    machine: { label: machine.label, os: machine.os },
    workspace: {
      cwd,
      ...(repo.repoName ? { repo_name: repo.repoName } : {}),
      ...(repo.branch ? { branch: repo.branch } : {}),
    },
    title: label ? `${label} — ${mapped.title}` : mapped.title,
    body: mapped.body,
    metadata,
  };
  // Shared normalizer hashes the cwd, redacts/truncates strings, enforces the size cap, and
  // validates against the canonical schema (or throws). metadata.session_name is cleaned by
  // exactly the same pipeline as the title lead it mirrors — a name a user typed a path or a
  // token into is hashed/redacted in BOTH places, never in one and not the other.
  return normalizeEvent(draft, opts);
}

/** Map + normalize a raw Claude Code hook payload into a validated canonical event. */
export function normalizeClaudeCodeEvent(
  input: unknown,
  opts: ClaudeCodeNormalizeOptions = {},
): Promise<BirdyBeepAgentEvent> {
  try {
    return Promise.resolve(buildAndNormalize(input, opts));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new ClaudeCodeMappingError(String(err)));
  }
}
