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
 * SubagentStart and TaskCreated/TaskCompleted are out of scope here (see SPEC §9.5).
 */
import { createHash } from "node:crypto";

import {
  type BirdyBeepAgentEvent,
  getMachineIdentity,
  normalizeEvent,
  type NormalizeOptions,
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
    case "Stop":
      return {
        eventType: "agent_completed",
        status: "completed",
        title: "Claude Code finished",
        body: "Turn complete",
        metadata: {},
      };
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
  const draft = {
    event_type: mapped.eventType,
    status: mapped.status,
    harness: "claude_code",
    source_session_id: sessionId && sessionId.length > 0 ? sessionId : bestEffortSessionId(payload),
    machine: { label: machine.label, os: machine.os },
    workspace: { cwd: str(payload["cwd"]) ?? "unknown" },
    title: mapped.title,
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
