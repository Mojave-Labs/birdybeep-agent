/**
 * OpenCode event mapping (§9.7 → §10.1). Pure: turns a raw OpenCode plugin event into a
 * draft BirdyBeep event, then runs it through agent-core's shared normalizer (path
 * hashing, secret redaction, body truncation, size cap, schema validation). Never
 * re-implements those rules; never echoes user/assistant content (message text, tool
 * args, permission titles, error messages) into the persisted event.
 *
 * VERIFIED against the OpenCode SDK types (sst/opencode `packages/sdk/.../types.gen.ts`),
 * NOT the PRD §9.7 table — see docs/SPEC.md §7 reconciliation. Two PRD-table corrections:
 *   - `permission.asked` DOES NOT EXIST → the real approval event is `permission.updated`.
 *   - `permission.replied` → the PRD maps it to a `permission_replied` type that is NOT in
 *     §10.1. Rather than invent a wire type (lockstep), it is DROPPED (skipped) — it's the
 *     user's reply, not an agent-attention moment — same precedent as the deferred Task*.
 *
 * The plugin forwards each event as `{ type, properties, cwd? }` (cwd injected by the
 * plugin from its PluginInput, since most bus events don't carry it). tool.execute.*
 * are OpenCode NAMED HOOKS (not bus events); the plugin wraps them in the same envelope.
 *
 *   session.created            → session_started
 *   session.updated            → session_active
 *   session.status {busy|retry}→ session_active   ; {idle} → agent_idle
 *   session.idle               → agent_idle
 *   session.error              → agent_failed
 *   permission.updated         → approval_required
 *   tool.execute.before        → tool_started
 *   tool.execute.after         → tool_finished
 */
import { createHash } from "node:crypto";

import {
  type BirdyBeepAgentEvent,
  getMachineIdentity,
  normalizeEvent,
  type NormalizeOptions,
} from "@birdybeep/agent-core";

/** Thrown for an unknown/garbled or intentionally-dropped OpenCode event (never a malformed event). */
export class OpenCodeMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeMappingError";
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

/** Deterministic best-effort session id when OpenCode provides none (§10.3). */
function bestEffortSessionId(cwd: string, type: string): string {
  return `oc_${createHash("sha256").update(`${cwd}|${type}`).digest("hex").slice(0, 16)}`;
}

/** Session identity (§10.3): properties.sessionID, else the Session object's id, else best-effort. */
function deriveSessionId(props: Record<string, unknown>, cwd: string, type: string): string {
  const explicit = str(props["sessionID"]) ?? str(asRecord(props["info"])["id"]);
  return explicit && explicit.length > 0 ? explicit : bestEffortSessionId(cwd, type);
}

function mapStatusEvent(props: Record<string, unknown>): MappedEvent {
  const statusType = str(asRecord(props["status"])["type"]);
  if (statusType === "idle") {
    return {
      eventType: "agent_idle",
      status: "idle",
      title: "OpenCode is waiting",
      body: "",
      metadata: {},
    };
  }
  if (statusType === "retry") {
    const attempt = asRecord(props["status"])["attempt"];
    return {
      eventType: "session_active",
      status: "running",
      title: "OpenCode is retrying",
      body: "",
      metadata: { attempt: typeof attempt === "number" ? attempt : undefined },
    };
  }
  // "busy" (and any other non-idle status) → active.
  return {
    eventType: "session_active",
    status: "running",
    title: "OpenCode is working",
    body: "",
    metadata: { status: statusType },
  };
}

function mapOpenCodeEvent(type: string, props: Record<string, unknown>): MappedEvent {
  switch (type) {
    case "session.created":
      return {
        eventType: "session_started",
        status: "starting",
        title: "OpenCode session started",
        body: "",
        metadata: {},
      };
    case "session.updated":
      return {
        eventType: "session_active",
        status: "running",
        title: "OpenCode session active",
        body: "",
        metadata: {},
      };
    case "session.status":
      return mapStatusEvent(props);
    case "session.idle":
      return {
        eventType: "agent_idle",
        status: "idle",
        title: "OpenCode is waiting",
        body: "Turn complete — awaiting input",
        metadata: {},
      };
    case "session.error": {
      // Only the safe error discriminator (class name) — never the raw message/data.
      const errorName = str(asRecord(props["error"])["name"]);
      return {
        eventType: "agent_failed",
        status: "failed",
        title: "OpenCode failed",
        body: "Session error",
        metadata: { error: errorName },
      };
    }
    case "permission.updated": {
      // `type` is a safe discriminator (e.g. "bash"/"edit"); `title`/`metadata` may carry
      // the actual command/path — not persisted.
      const permissionType = str(props["type"]);
      return {
        eventType: "approval_required",
        status: "waiting_for_approval",
        title: "OpenCode needs approval",
        body: "Approval requested",
        metadata: { permission_type: permissionType },
      };
    }
    case "tool.execute.before": {
      const tool = str(props["tool"]);
      return {
        eventType: "tool_started",
        status: "running",
        title: "OpenCode tool started",
        body: tool ? `${tool} started` : "Tool started",
        metadata: { tool },
      };
    }
    case "tool.execute.after": {
      const tool = str(props["tool"]);
      return {
        eventType: "tool_finished",
        status: "running",
        title: "OpenCode tool finished",
        body: tool ? `${tool} finished` : "Tool finished",
        metadata: { tool },
      };
    }
    default:
      // Includes permission.replied (user's reply — no §10.1 attention event; not invented)
      // and every non-lifecycle bus event (message.*, file.*, etc.). Dropped, not emitted.
      throw new OpenCodeMappingError(`unsupported OpenCode event: ${JSON.stringify(type)}`);
  }
}

function buildAndNormalize(input: unknown, opts: NormalizeOptions): BirdyBeepAgentEvent {
  const payload = asRecord(input);
  const type = payload["type"];
  if (typeof type !== "string") {
    throw new OpenCodeMappingError("payload is missing a string event type");
  }
  const props = asRecord(payload["properties"]);
  const cwd = str(payload["cwd"]) ?? str(asRecord(props["info"])["directory"]) ?? "unknown";
  const mapped = mapOpenCodeEvent(type, props); // throws OpenCodeMappingError on unmapped
  const machine = getMachineIdentity();
  const draft = {
    event_type: mapped.eventType,
    status: mapped.status,
    harness: "opencode",
    source_session_id: deriveSessionId(props, cwd, type),
    machine: { label: machine.label, os: machine.os },
    workspace: { cwd },
    title: mapped.title,
    body: mapped.body,
    metadata: mapped.metadata,
  };
  // Shared normalizer hashes the cwd, redacts/truncates strings, enforces the size
  // cap, and validates against the canonical schema (or throws).
  return normalizeEvent(draft, opts);
}

/** Map + normalize a raw OpenCode plugin event into a validated canonical event. */
export function normalizeOpenCodeEvent(
  input: unknown,
  opts: NormalizeOptions = {},
): Promise<BirdyBeepAgentEvent> {
  try {
    return Promise.resolve(buildAndNormalize(input, opts));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new OpenCodeMappingError(String(err)));
  }
}
