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
  type RepoContext,
} from "@birdybeep/agent-core";

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

/** Longest one-line completion body we compose before the normalizer's own caps take over. */
const SUMMARY_MAX_CHARS = 200;

/**
 * Condense Claude Code's `last_assistant_message` into a one-line push body.
 * Heuristic: the first non-empty line (agents usually lead with the headline),
 * whitespace-collapsed and truncated. Returns undefined for an absent/blank
 * message so the caller can fall back. Path/secret scrubbing is the normalizer's job.
 */
function summarizeLastMessage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  const collapsed = firstLine.replace(/\s+/g, " ");
  return collapsed.length > SUMMARY_MAX_CHARS
    ? `${collapsed.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : collapsed;
}

/** "<repo> · <branch>" (or just "<repo>") to lead the push title; undefined when cwd isn't a checkout. */
function repoLabel(ctx: RepoContext): string | undefined {
  if (!ctx.repoName) return undefined;
  return ctx.branch ? `${ctx.repoName} · ${ctx.branch}` : ctx.repoName;
}

/** Deterministic best-effort session id when Claude Code provides none (§10.3). */
function bestEffortSessionId(payload: Record<string, unknown>): string {
  const seed = `${str(payload["cwd"]) ?? ""}|${str(payload["transcript_path"]) ?? ""}|${str(payload["hook_event_name"]) ?? ""}`;
  return `cc_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
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
      throw new ClaudeCodeMappingError(
        `unsupported Claude Code hook event: ${JSON.stringify(name)}`,
      );
  }
}

function buildAndNormalize(input: unknown, opts: NormalizeOptions): BirdyBeepAgentEvent {
  const payload = asRecord(input);
  if (typeof payload["hook_event_name"] !== "string") {
    throw new ClaudeCodeMappingError("payload is missing a string hook_event_name");
  }
  const mapped = mapHookEvent(payload); // throws ClaudeCodeMappingError on unknown event
  const sessionId = str(payload["session_id"]);
  const machine = getMachineIdentity();
  const cwd = str(payload["cwd"]) ?? "unknown";
  // Best-effort, fail-soft: which checkout produced this event (§10.2). Populates the
  // repo/branch workspace labels AND leads the title so parallel sessions are told apart.
  const repo = detectRepoContext(cwd);
  const label = repoLabel(repo);
  const draft = {
    event_type: mapped.eventType,
    status: mapped.status,
    harness: "claude_code",
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
  // Shared normalizer hashes the cwd, redacts/truncates strings, enforces the size
  // cap, and validates against the canonical schema (or throws).
  return normalizeEvent(draft, opts);
}

/** Map + normalize a raw Claude Code hook payload into a validated canonical event. */
export function normalizeClaudeCodeEvent(
  input: unknown,
  opts: NormalizeOptions = {},
): Promise<BirdyBeepAgentEvent> {
  try {
    return Promise.resolve(buildAndNormalize(input, opts));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new ClaudeCodeMappingError(String(err)));
  }
}
