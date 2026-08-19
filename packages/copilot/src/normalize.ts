/**
 * Map Copilot CLI's camelCase hook payloads into privacy-safe BirdyBeep events. The hook event
 * name is supplied separately because these payloads deliberately carry no event discriminator.
 * Raw prompt, tool arguments/results, transcript paths, error messages/stacks, and subagent
 * response content are never copied into a draft event.
 */
import { createHash } from "node:crypto";

import {
  type BirdyBeepAgentEvent,
  detectRepoContext,
  getMachineIdentity,
  normalizeEvent,
  type NormalizeOptions,
  type RepoContext,
  sanitizeHarnessVersion,
} from "@birdybeep/agent-core";

import { type CopilotHookEventName, isCopilotHookEventName } from "./install";

/** Options for {@link normalizeCopilotEvent}; extends the shared normalizer options. */
export interface CopilotNormalizeOptions extends NormalizeOptions {
  /** Environment Copilot exported into this hook (default `process.env`). Tests override. */
  env?: NodeJS.ProcessEnv;
}

export class CopilotMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopilotMappingError";
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
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function repoLabel(context: RepoContext): string | undefined {
  if (!context.repoName) return undefined;
  return context.branch ? `${context.repoName} · ${context.branch}` : context.repoName;
}

function bestEffortSessionId(eventName: string, payload: Record<string, unknown>): string {
  const seed = `${str(payload["cwd"]) ?? ""}|${eventName}`;
  return `cop_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

/**
 * The Copilot CLI version that fired this hook (birdybeep-agent-gcgp.7), or undefined.
 *
 * Copilot's camelCase payloads carry no version, but the CLI exports
 * `COPILOT_CLI_BINARY_VERSION` into every hook child — captured live from Copilot CLI 1.0.78,
 * matching `copilot --version`. Reading the env costs nothing and names the binary that
 * actually ran, which a PATH probe would only coincidentally agree with.
 */
function copilotVersion(env: NodeJS.ProcessEnv): string | undefined {
  return sanitizeHarnessVersion(env["COPILOT_CLI_BINARY_VERSION"]);
}

/**
 * Does this payload come from Copilot CLI (birdybeep-agent-gcgp.14)?
 *
 * Copilot is the one harness whose payloads carry NO event discriminator — the event name
 * arrives as an argv argument — so `normalizeCopilotEvent` maps whatever object it is handed.
 * A foreign payload therefore did not skip: it produced and SENT a fabricated Copilot event.
 * `sessionId` is the discriminator that stops that. It is present on every captured payload
 * (`src/__fixtures__/*.json`) and is camelCase, which no other harness's payload uses —
 * Claude Code, Codex and Cursor all key on snake_case `session_id`.
 *
 * `cwd` and `timestamp` are equally universal in the captures but are deliberately NOT
 * required: a future Copilot event that omits one must stay mappable, not become an error on
 * every fire.
 */
export function isCopilotHookPayload(input: unknown): boolean {
  return typeof asRecord(input)["sessionId"] === "string";
}

function mapCopilotEvent(
  eventName: CopilotHookEventName,
  payload: Record<string, unknown>,
): MappedEvent {
  switch (eventName) {
    case "sessionStart":
      return {
        eventType: "session_started",
        status: "starting",
        title: "Copilot session started",
        body: "",
        metadata: { source: str(payload["source"]) },
      };
    case "userPromptSubmitted":
      return {
        eventType: "session_active",
        status: "running",
        title: "Copilot is working",
        body: "Prompt submitted",
        metadata: {},
      };
    case "preToolUse": {
      const tool = str(payload["toolName"]);
      return {
        eventType: "tool_started",
        status: "running",
        title: "Copilot tool started",
        body: tool ? `${tool} started` : "Tool started",
        metadata: { tool },
      };
    }
    case "postToolUse": {
      const tool = str(payload["toolName"]);
      const result = asRecord(payload["toolResult"]);
      return {
        eventType: "tool_finished",
        status: "running",
        title: "Copilot tool finished",
        body: tool ? `${tool} finished` : "Tool finished",
        metadata: { tool, result_type: str(result["resultType"]) },
      };
    }
    case "agentStop":
      return {
        eventType: "agent_completed",
        status: "completed",
        title: "Copilot finished",
        body: "Turn complete",
        metadata: {
          stop_reason: str(payload["stopReason"]),
          stop_hook_active:
            typeof payload["stop_hook_active"] === "boolean"
              ? payload["stop_hook_active"]
              : undefined,
        },
      };
    case "subagentStop":
      return {
        eventType: "subagent_completed",
        status: "running",
        title: "Copilot subagent finished",
        body: "Subtask complete",
        metadata: {
          agent: str(payload["agentName"]),
          agent_type: str(payload["agentType"]),
          stop_reason: str(payload["stopReason"]),
        },
      };
    case "errorOccurred": {
      const error = asRecord(payload["error"]);
      return {
        eventType: "agent_failed",
        status: "failed",
        title: "Copilot encountered an error",
        body: "Agent execution failed",
        metadata: {
          error_name: str(error["name"]),
          error_context: str(payload["errorContext"]),
          recoverable:
            typeof payload["recoverable"] === "boolean" ? payload["recoverable"] : undefined,
        },
      };
    }
    case "sessionEnd": {
      const reason = str(payload["reason"]) ?? "other";
      const failed = reason === "error" || reason === "timeout";
      return {
        eventType: "session_ended",
        status: failed ? "failed" : "completed",
        title: "Copilot session ended",
        body: `Session ended (${reason})`,
        metadata: { reason },
      };
    }
  }
}

export function normalizeCopilotEvent(
  eventName: string,
  input: unknown,
  options: CopilotNormalizeOptions = {},
): Promise<BirdyBeepAgentEvent> {
  try {
    if (!isCopilotHookEventName(eventName)) {
      throw new CopilotMappingError(`unsupported Copilot hook event: ${JSON.stringify(eventName)}`);
    }
    const payload = asRecord(input);
    const mapped = mapCopilotEvent(eventName, payload);
    const cwd = str(payload["cwd"]) ?? "unknown";
    const sessionId = str(payload["sessionId"]);
    const machine = getMachineIdentity();
    const repo = detectRepoContext(cwd);
    const label = repoLabel(repo);
    const harnessVersion = copilotVersion(options.env ?? process.env);

    return Promise.resolve(
      normalizeEvent(
        {
          event_type: mapped.eventType,
          status: mapped.status,
          harness: "copilot",
          ...(harnessVersion ? { harness_version: harnessVersion } : {}),
          source_session_id:
            sessionId && sessionId.length > 0 ? sessionId : bestEffortSessionId(eventName, payload),
          machine: { label: machine.label, os: machine.os },
          workspace: {
            cwd,
            ...(repo.repoName ? { repo_name: repo.repoName } : {}),
            ...(repo.branch ? { branch: repo.branch } : {}),
          },
          title: label ? `${label} — ${mapped.title}` : mapped.title,
          body: mapped.body,
          metadata: mapped.metadata,
        },
        options,
      ),
    );
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new CopilotMappingError(String(error)));
  }
}
