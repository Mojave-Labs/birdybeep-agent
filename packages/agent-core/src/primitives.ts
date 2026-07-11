/**
 * Primitive enums + guards for the canonical agent event (§10.1, §10.4, §13.5).
 *
 * LOCKSTEP (§16.4): these unions MIRROR the product repo's `@birdybeep/shared`
 * (HARNESS_IDS / BIRDYBEEP_EVENT_TYPES / AGENT_SESSION_STATUSES) and the zod
 * validators in its `packages/schemas`. The agent repo cannot import the private
 * `@birdybeep/shared`, so the values are vendored here — any change there MUST be
 * mirrored here (the schema parity test fails if the agent side drifts).
 */
import { z } from "zod";

/** Every agent event type, in PRD §10.1 order. Mirrors @birdybeep/shared BIRDYBEEP_EVENT_TYPES. */
export const BIRDYBEEP_EVENT_TYPES = [
  "session_started",
  "session_resumed",
  "session_active",
  "needs_input",
  "approval_required",
  "agent_idle",
  "agent_completed",
  "agent_failed",
  "test_failed",
  "tool_started",
  "tool_finished",
  "subagent_started",
  "subagent_completed",
  "custom",
  // "test" (9fh): the `birdybeep test` diagnostic. Notifies by default server-side
  // (unlike "custom", which the §10.5 matrix suppresses unconditionally) and is
  // quota-exempt — the product's DEFAULT_NOTIFY/gauntlet carry the other half.
  "test",
  // "session_ended": a harness signalled a session truly ended (e.g. Claude Code's
  // SessionEnd hook). Non-notifying server-side; carries a terminal status. Appended
  // last to preserve every existing ordinal — mirrors @birdybeep/shared.
  "session_ended",
] as const;
export type BirdyBeepEventType = (typeof BIRDYBEEP_EVENT_TYPES)[number];

/** Every session status, in PRD §10.4 order. Mirrors @birdybeep/shared AGENT_SESSION_STATUSES. */
export const AGENT_SESSION_STATUSES = [
  "starting",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "idle",
  "completed",
  "failed",
  "unknown",
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

/** Supported harness ids (§9.5–9.7). Mirrors @birdybeep/shared HARNESS_IDS. */
export const HARNESS_IDS = ["claude_code", "codex", "opencode"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/** Enum validators derived from the vendored tuples so the validator can't drift from the type. */
export const eventTypeSchema = z.enum(BIRDYBEEP_EVENT_TYPES); // §10.1
export const sessionStatusSchema = z.enum(AGENT_SESSION_STATUSES); // §10.4
export const harnessSchema = z.enum(HARNESS_IDS); // §9.5–9.7

/** ISO 8601 timestamp, e.g. "2026-06-11T12:34:56.000Z" (trailing Z or numeric offset). */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** Max accepted agent-event request body, in bytes (§13.5). Mirrors the product MAX_AGENT_EVENT_BYTES. */
export const MAX_AGENT_EVENT_BYTES = 16 * 1024;

/**
 * Whether a raw agent-event body is within the size cap (§13.5). Platform-neutral
 * (no TextEncoder / Buffer): pass the body's byte length, or the raw bytes.
 */
export function isWithinMaxAgentEventSize(body: number | ArrayBuffer | ArrayBufferView): boolean {
  const bytes = typeof body === "number" ? body : body.byteLength;
  return bytes <= MAX_AGENT_EVENT_BYTES;
}
