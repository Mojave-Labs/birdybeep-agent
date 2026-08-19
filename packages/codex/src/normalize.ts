/**
 * Codex event mapping (§9.6 → §10.1). Pure: turns a raw Codex payload — either a
 * `notify` program payload (argv JSON, kebab-case, keyed by `type`) or a lifecycle
 * hook payload (stdin JSON, snake_case, keyed by `hook_event_name`) — into a draft
 * BirdyBeep event, then runs it through agent-core's shared normalizer (path hashing,
 * secret redaction, body truncation, size cap, schema validation). Never re-implements
 * those rules; never echoes user/assistant content (input messages, last-assistant
 * message, tool input/response) into the persisted event.
 *
 * VERIFIED against the current Codex source (openai/codex `codex-rs/hooks`), not the
 * PRD §9.6 table — see docs/SPEC.md §6 reconciliation. Two real surfaces:
 *
 *   hook SessionStart                    → session_started / session_resumed (by source)
 *   hook PermissionRequest               → approval_required (the real approval signal)
 *   hook PostToolUse                     → tool_finished
 *   hook SubagentStart                   → subagent_started
 *   hook SubagentStop                    → subagent_completed
 *   hook Stop                            → agent_completed   (the turn-complete signal
 *                                          BirdyBeep registers)
 *   notify {type:"agent-turn-complete"}  → agent_completed   (the ONLY notify type; still
 *                                          mapped for configs an older BirdyBeep patched,
 *                                          and for third-party notify chains that forward
 *                                          to `birdybeep hook codex`)
 *
 * notify carries JSON on argv; hooks carry JSON on stdin. The `birdybeep hook codex`
 * entrypoint feeds either shape here; dispatch keys off `hook_event_name` vs `type`.
 *
 * NO `metadata.session_name` (audited for birdybeep-agent-991): Codex exposes no session/
 * thread NAME on either surface. The hook payloads carry `session_id`, `source`, `model`,
 * `tool_name`; notify carries `thread-id`, `turn-id`, `client`. Those are IDs and
 * discriminators, not human names — sending an opaque id as a "session name" would give the
 * server's `titleFormat="session_name"` a worse title than the graceful fallback it already
 * has. Nothing to emit until Codex surfaces a real name.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

import {
  type BirdyBeepAgentEvent,
  getMachineIdentity,
  normalizeEvent,
  type NormalizeOptions,
  sanitizeHarnessVersion,
} from "@birdybeep/agent-core";

/**
 * Options for {@link normalizeCodexEvent}. Extends the shared normalizer options with an
 * injectable rollout reader so the version lookup is testable without a real rollout file.
 */
export interface CodexNormalizeOptions extends NormalizeOptions {
  /**
   * Resolve the Codex CLI version from the session rollout at `transcriptPath`
   * (default {@link cliVersionFromRollout}). Tests override; production uses the real read.
   */
  readRolloutVersion?: (transcriptPath: string) => string | undefined;
}

/** Thrown for an unknown/garbled Codex payload (never a malformed event). */
export class CodexMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexMappingError";
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

/** Deterministic best-effort session id when Codex provides none (§10.3). */
function bestEffortSessionId(payload: Record<string, unknown>): string {
  const seed = [
    str(payload["cwd"]) ?? "",
    str(payload["hook_event_name"]) ?? str(payload["type"]) ?? "",
    str(payload["turn_id"]) ?? str(payload["turn-id"]) ?? "",
  ].join("|");
  return `cx_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

/** Session identity (§10.3): hook `session_id`, notify `thread-id`, else best-effort. */
function deriveSessionId(payload: Record<string, unknown>): string {
  const explicit = str(payload["session_id"]) ?? str(payload["thread-id"]);
  return explicit && explicit.length > 0 ? explicit : bestEffortSessionId(payload);
}

// --- harness_version (birdybeep-agent-gcgp.7) ---------------------------------------
// Codex hook payloads carry no version field (captured live from codex-cli 0.135.0 and from
// the ChatGPT.app-bundled 0.148.0-alpha.9), and it exports no version env var either — the
// npm install sets CODEX_MANAGED_PACKAGE_ROOT, the bundled build sets nothing. What EVERY
// hook payload does carry is `transcript_path`: Codex's own embedded payload schemas list it
// as required for all ten hook events (SessionStart, PermissionRequest, Pre/PostToolUse,
// Subagent{Start,Stop}, Stop, UserPromptSubmit, Pre/PostCompact). The first line of that
// rollout is a `session_meta` record holding `cli_version`, written before the first hook fires.
//
// This matters more for Codex than for any other harness: the terminal CLI and the
// ChatGPT-desktop-bundled build SHARE ONE `~/.codex/config.toml` — same hooks, same trust
// state, same everything — so the rollout's own `cli_version` is the only thing that tells
// the two apart. Verified: one sandbox CODEX_HOME, two binaries, 0.135.0 vs 0.148.0-alpha.9.
//
// The `notify` surface has no transcript path (a different, kebab-case payload), so notify
// events simply carry no version — the field stays absent rather than guessed.
/** Head bytes scanned for the rollout's first line (~22 KB observed; cap well clear of it). */
const ROLLOUT_HEAD_MAX_BYTES = 256 * 1024;

/**
 * Read `cli_version` out of the `session_meta` line that opens a Codex rollout, or undefined.
 *
 * Bounded and fail-soft by construction — this runs on the hook path, which must never block
 * or slow the harness: ONE synchronous read of at most {@link ROLLOUT_HEAD_MAX_BYTES}, only
 * the first line is parsed, and every failure (missing file, truncated line, unparseable JSON,
 * a different record type) returns undefined instead of throwing. Nothing but the version
 * string is read out of the record — a rollout also holds the user's prompts, which must never
 * enter an event (§15).
 */
export function cliVersionFromRollout(transcriptPath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const buffer = Buffer.allocUnsafe(ROLLOUT_HEAD_MAX_BYTES);
    const read = readSync(fd, buffer, 0, ROLLOUT_HEAD_MAX_BYTES, 0);
    const head = buffer.toString("utf8", 0, read);
    const newline = head.indexOf("\n");
    if (newline < 0) return undefined; // first line longer than the cap → give up, never guess
    const meta = asRecord(JSON.parse(head.slice(0, newline)));
    if (meta["type"] !== "session_meta") return undefined;
    return sanitizeHarnessVersion(asRecord(meta["payload"])["cli_version"]);
  } catch {
    return undefined; // absent/unreadable/garbled rollout is not an error — the field is optional
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do; never let cleanup break event delivery */
      }
    }
  }
}

/** Map a Codex lifecycle hook payload (keyed by `hook_event_name`). */
function mapHookEvent(payload: Record<string, unknown>, name: string): MappedEvent {
  switch (name) {
    case "SessionStart": {
      const resumed = payload["source"] === "resume";
      return {
        eventType: resumed ? "session_resumed" : "session_started",
        status: resumed ? "running" : "starting",
        title: `Codex session ${resumed ? "resumed" : "started"}`,
        body: "",
        metadata: { source: str(payload["source"]), model: str(payload["model"]) },
      };
    }
    case "PermissionRequest": {
      // tool_name is a safe identifier (e.g. "Bash"); tool_input is content — never persisted.
      const tool = str(payload["tool_name"]);
      return {
        eventType: "approval_required",
        status: "waiting_for_approval",
        title: "Codex needs approval",
        body: tool ? `Approve ${tool}?` : "Approval requested",
        metadata: { tool },
      };
    }
    case "PostToolUse": {
      const tool = str(payload["tool_name"]);
      return {
        eventType: "tool_finished",
        status: "running",
        title: "Codex tool finished",
        body: tool ? `${tool} finished` : "Tool finished",
        metadata: { tool },
      };
    }
    case "SubagentStart":
      return {
        eventType: "subagent_started",
        status: "running",
        title: "Subagent started",
        body: "Subtask started",
        metadata: { agent_type: str(payload["agent_type"]), agent_id: str(payload["agent_id"]) },
      };
    case "SubagentStop":
      return {
        eventType: "subagent_completed",
        status: "running",
        title: "Subagent finished",
        body: "Subtask complete",
        metadata: { agent_type: str(payload["agent_type"]), agent_id: str(payload["agent_id"]) },
      };
    case "Stop":
      // last_assistant_message is assistant content — intentionally NOT persisted.
      return {
        eventType: "agent_completed",
        status: "completed",
        title: "Codex finished",
        body: "Turn complete",
        metadata: { turn_id: str(payload["turn_id"]), model: str(payload["model"]) },
      };
    default:
      throw new CodexMappingError(`unsupported Codex hook event: ${JSON.stringify(name)}`);
  }
}

/** Map a Codex `notify` payload (keyed by `type`; only `agent-turn-complete` exists). */
function mapNotifyEvent(payload: Record<string, unknown>, type: string): MappedEvent {
  if (type === "agent-turn-complete") {
    // input-messages / last-assistant-message are user+assistant content — intentionally
    // NOT persisted. Only the safe turn/client identifiers flow as metadata.
    return {
      eventType: "agent_completed",
      status: "completed",
      title: "Codex finished",
      body: "Turn complete",
      metadata: { turn_id: str(payload["turn-id"]), client: str(payload["client"]) },
    };
  }
  throw new CodexMappingError(`unsupported Codex notify type: ${JSON.stringify(type)}`);
}

function mapCodexPayload(payload: Record<string, unknown>): MappedEvent {
  const hookName = payload["hook_event_name"];
  if (typeof hookName === "string") return mapHookEvent(payload, hookName);
  const notifyType = payload["type"];
  if (typeof notifyType === "string") return mapNotifyEvent(payload, notifyType);
  throw new CodexMappingError("payload has neither a string hook_event_name nor type");
}

/**
 * Is this payload a TRUST-GATED lifecycle hook (vs. the notify program)?
 *
 * This is the trust signal (birdybeep-agent-qyf). Codex refuses to run a `[[hooks.X]]`
 * command until the user reviews and trusts it via `/hooks`, so a hook payload arriving
 * here is proof trust was granted. The top-level `notify` program has NO such gate —
 * Codex runs it on every turn-complete regardless — so a notify payload proves nothing.
 *
 * Deliberately mirrors {@link mapCodexPayload}'s dispatch precedence (hook_event_name
 * wins over type): whatever the mapper treats as a hook is what we count as trust proof,
 * so the two can never disagree.
 */
export function isCodexLifecycleHookPayload(input: unknown): boolean {
  return typeof asRecord(input)["hook_event_name"] === "string";
}

function buildAndNormalize(input: unknown, opts: CodexNormalizeOptions): BirdyBeepAgentEvent {
  const payload = asRecord(input);
  const mapped = mapCodexPayload(payload); // throws CodexMappingError on unknown
  const machine = getMachineIdentity();
  // Which Codex build fired this — the terminal CLI or the ChatGPT desktop bundle. Both share
  // one config, so the rollout's own cli_version is the only thing that separates them.
  const transcriptPath = str(payload["transcript_path"]);
  const readVersion = opts.readRolloutVersion ?? cliVersionFromRollout;
  const harnessVersion = transcriptPath ? readVersion(transcriptPath) : undefined;
  const draft = {
    event_type: mapped.eventType,
    status: mapped.status,
    harness: "codex",
    ...(harnessVersion ? { harness_version: harnessVersion } : {}),
    source_session_id: deriveSessionId(payload),
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

/** Map + normalize a raw Codex notify/hook payload into a validated canonical event. */
export function normalizeCodexEvent(
  input: unknown,
  opts: CodexNormalizeOptions = {},
): Promise<BirdyBeepAgentEvent> {
  try {
    return Promise.resolve(buildAndNormalize(input, opts));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new CodexMappingError(String(err)));
  }
}
