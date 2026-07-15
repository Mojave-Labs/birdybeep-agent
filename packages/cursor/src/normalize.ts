/**
 * Cursor event mapping (§9.x → §10.1). Pure: turns a raw Cursor hook payload (keyed by
 * `hook_event_name`, delivered as JSON on stdin) into a draft BirdyBeep event, then runs it
 * through agent-core's shared normalizer (path hashing, secret redaction, body truncation,
 * size cap, schema validation) — never re-implementing those rules.
 *
 * CRITICAL PRIVACY (verified live 2026-07-15): Cursor payloads carry `user_email` (PII) and
 * `transcript_path` (a local filesystem path). Neither is EVER copied into the normalized
 * event — not the title, body, metadata, session id, or workspace. They are dropped entirely.
 * The only path we touch is `workspace_roots[0]`, handed to the normalizer as `cwd` so it is
 * HASHED (no raw path leaves the machine).
 *
 * Mapping (see docs/adapter-development.md):
 *   sessionStart                          → session_started (status "starting")
 *   sessionEnd {final_status:"completed"} → agent_completed  (the completion beep — see below)
 *   sessionEnd {other}                    → session_ended    (terminal, non-notifying)
 *   stop                                  → agent_completed  (IDE turn-complete)
 *   beforeShellExecution                  → approval_required (shell command permission gate)
 *   preToolUse                            → tool_started
 *   postToolUse                           → tool_finished
 *   subagentStart                         → subagent_started
 *   subagentStop                          → subagent_completed
 *   anything else (beforeSubmitPrompt / postToolUseFailure / afterAgentResponse / unknown)
 *                                         → throw CursorMappingError → the hook returns "skipped"
 *
 * WHY sessionEnd-completed → agent_completed (not session_ended): headless `cursor-agent -p`
 * fires ONLY sessionStart + sessionEnd — it never fires `stop`. So for CLI users, a
 * completed sessionEnd is the ONLY completion signal there is; mapping it to agent_completed
 * gives them the "your agent finished" beep. IDE users additionally get `stop`, and a
 * non-completed sessionEnd (cancelled/errored) settles terminal via session_ended.
 */
import { createHash } from "node:crypto";

import {
  type BirdyBeepAgentEvent,
  detectRepoContext,
  getMachineIdentity,
  normalizeEvent,
  type NormalizeOptions,
  type RepoContext,
} from "@birdybeep/agent-core";

/** Thrown for an unknown/garbled Cursor hook payload (never a malformed event). */
export class CursorMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorMappingError";
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

/** The first workspace root Cursor reports (used as cwd); undefined when absent. */
function firstWorkspaceRoot(payload: Record<string, unknown>): string | undefined {
  const roots = payload["workspace_roots"];
  if (Array.isArray(roots)) return str(roots[0]);
  return undefined;
}

/** "<repo> · <branch>" (or just "<repo>") to lead the push title; undefined when cwd isn't a checkout. */
function repoLabel(ctx: RepoContext): string | undefined {
  if (!ctx.repoName) return undefined;
  return ctx.branch ? `${ctx.repoName} · ${ctx.branch}` : ctx.repoName;
}

/** Deterministic best-effort session id when Cursor provides none (§10.3). */
function bestEffortSessionId(payload: Record<string, unknown>): string {
  const seed = `${firstWorkspaceRoot(payload) ?? ""}|${str(payload["hook_event_name"]) ?? ""}`;
  return `cur_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function mapCursorEvent(payload: Record<string, unknown>, name: string): MappedEvent {
  switch (name) {
    case "sessionStart":
      return {
        eventType: "session_started",
        status: "starting",
        title: "Cursor session started",
        body: "",
        // model / is_background_agent are safe identifiers; user_email is NOT carried.
        metadata: {
          model: str(payload["model"]),
          is_background_agent: payload["is_background_agent"],
        },
      };
    case "sessionEnd": {
      const finalStatus = str(payload["final_status"]);
      const reason = str(payload["reason"]) ?? "other";
      if (finalStatus === "completed") {
        // The completion beep for CLI users (see file header) — cursor-agent -p never fires `stop`.
        return {
          eventType: "agent_completed",
          status: "completed",
          title: "Cursor finished",
          body: "Session complete",
          metadata: { final_status: finalStatus, reason },
        };
      }
      return {
        eventType: "session_ended",
        status: "completed", // terminal → settles the session into the "ended" bucket
        title: "Cursor session ended",
        body: `Session ended (${reason})`,
        metadata: { final_status: finalStatus, reason },
      };
    }
    case "stop":
      return {
        eventType: "agent_completed",
        status: "completed",
        title: "Cursor finished",
        body: "Turn complete",
        metadata: {},
      };
    case "beforeShellExecution":
      // The shell-command permission gate — the headline approval beep. The raw command is
      // content and is intentionally NOT persisted.
      return {
        eventType: "approval_required",
        status: "waiting_for_approval",
        title: "Cursor needs approval",
        body: "Approve shell command?",
        metadata: {},
      };
    case "preToolUse": {
      // tool_name is a safe identifier (e.g. "Edit"); tool arguments are content — never persisted.
      const tool = str(payload["tool_name"]);
      return {
        eventType: "tool_started",
        status: "running",
        title: "Cursor tool started",
        body: tool ? `${tool} started` : "Tool started",
        metadata: { tool },
      };
    }
    case "postToolUse": {
      const tool = str(payload["tool_name"]);
      return {
        eventType: "tool_finished",
        status: "running",
        title: "Cursor tool finished",
        body: tool ? `${tool} finished` : "Tool finished",
        metadata: { tool },
      };
    }
    case "subagentStart":
      return {
        eventType: "subagent_started",
        status: "running",
        title: "Subagent started",
        body: "Subtask started",
        metadata: {},
      };
    case "subagentStop":
      return {
        eventType: "subagent_completed",
        status: "running",
        title: "Subagent finished",
        body: "Subtask complete",
        metadata: {},
      };
    default:
      // beforeSubmitPrompt / postToolUseFailure / afterAgentResponse / anything unknown: no
      // §10.1 target → skip (the hook returns "skipped"; never a malformed event).
      throw new CursorMappingError(`unsupported Cursor hook event: ${JSON.stringify(name)}`);
  }
}

function buildAndNormalize(input: unknown, opts: NormalizeOptions): BirdyBeepAgentEvent {
  const payload = asRecord(input);
  const name = payload["hook_event_name"];
  if (typeof name !== "string") {
    throw new CursorMappingError("payload is missing a string hook_event_name");
  }
  const mapped = mapCursorEvent(payload, name); // throws CursorMappingError on unknown event
  const sessionId = str(payload["session_id"]);
  const machine = getMachineIdentity();
  // cwd is workspace_roots[0]; the normalizer HASHES it. transcript_path is never touched.
  const cwd = firstWorkspaceRoot(payload) ?? "unknown";
  // Best-effort, fail-soft: which checkout produced this event (§10.2). Leads the title so
  // parallel sessions are told apart, and populates the repo/branch workspace labels.
  const repo = detectRepoContext(cwd);
  const label = repoLabel(repo);

  const draft: Record<string, unknown> = {
    event_type: mapped.eventType,
    status: mapped.status,
    harness: "cursor",
    source_session_id: sessionId && sessionId.length > 0 ? sessionId : bestEffortSessionId(payload),
    machine: { label: machine.label, os: machine.os },
    workspace: {
      cwd,
      ...(repo.repoName ? { repo_name: repo.repoName } : {}),
      ...(repo.branch ? { branch: repo.branch } : {}),
    },
    title: label ? `${label} — ${mapped.title}` : mapped.title,
    body: mapped.body,
    metadata: mapped.metadata,
  };
  // harness_version = cursor_version (a safe version string, cleaned by the normalizer).
  const cursorVersion = str(payload["cursor_version"]);
  if (cursorVersion) draft["harness_version"] = cursorVersion;

  // Shared normalizer hashes the cwd, redacts/truncates strings, enforces the size cap, and
  // validates against the canonical schema (or throws).
  return normalizeEvent(draft, opts);
}

/** Map + normalize a raw Cursor hook payload into a validated canonical event. */
export function normalizeCursorEvent(
  input: unknown,
  opts: NormalizeOptions = {},
): Promise<BirdyBeepAgentEvent> {
  try {
    return Promise.resolve(buildAndNormalize(input, opts));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new CursorMappingError(String(err)));
  }
}
