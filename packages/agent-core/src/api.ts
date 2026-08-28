/**
 * API error/response contract (§13.4) — MIRRORED from the product
 * `packages/schemas/api.ts` (their ticket 95e). The single wire-facing error shape
 * the Worker emits and this CLI parses; agent-core's sender keys retry-vs-terminal
 * off these codes. LOCKSTEP (§16.4): keep ERROR_CODES / the envelope / ERROR_STATUS
 * identical to the product. Additive to and independent of the §10.2 event payload.
 *
 * Messages are human-readable text only — never notification title/body or request
 * content (§15.2); `details` is for safe structured hints (e.g. which field failed).
 */
import { z } from "zod";

/** Stable, machine-readable error codes the client keys off. */
export const ERROR_CODES = [
  "validation_failed",
  "unauthorized",
  "forbidden",
  "token_revoked",
  "not_found",
  "payload_too_large",
  "rate_limited",
  "quota_exceeded",
  "internal_error",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The error response envelope: `{ error: { code, message, details? }, requestId? }`. */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
  requestId: z.string().optional(),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** Generic success envelope (`{ data }`) for endpoints that opt into wrapping. */
export const successEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) => z.object({ data });
export type SuccessEnvelope<T> = { data: T };

/**
 * Canonical HTTP status per error code — part of the contract: a given code always
 * maps to this status, so the client can branch on either.
 */
export const ERROR_STATUS = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  token_revoked: 403,
  not_found: 404,
  payload_too_large: 413,
  rate_limited: 429,
  quota_exceeded: 429,
  internal_error: 500,
} as const satisfies Record<ErrorCode, number>;

/**
 * `GET /v1/machine/push-reachability` response — MIRRORED from the product
 * `packages/schemas/api.ts` (birdybeep-agent-oi3). LOCKSTEP (§16.4): keep this identical to the
 * product's `pushReachabilityResponseSchema`.
 *
 * The one question every other check leaves unasked: can this ACCOUNT receive a beep? `doctor`
 * inspects the machine — token, hooks, harness builds, network — and reported a full green board
 * while the only device on the account had been stale for five weeks and every push landed on a
 * dead registration. METADATA ONLY (§15.2): counts, timestamps, a delivery status. If a push
 * token, device name or notification content ever appears here, that is a violation.
 */
/**
 * The account's beep meter, as the backend's DECISION stage sees it — MIRRORED from the product
 * `packages/schemas/api.ts` (birdybeep-agent-58l). LOCKSTEP (§16.4).
 *
 * The other half of "can this account beep", and the half nothing could see: /v1/agent-events
 * answers 202 and the quota gate rejects the event AFTERWARDS, so for a month every notifiable
 * event on the owner's account was rejected while `doctor` printed green and this CLI reported
 * every event delivered. Both window bounds are on the wire so a STUCK window is visible on
 * sight — "100/100, period ends 2026-07-27" read in August is a bug you can see, and that exact
 * lockout (n9mn) hid for a month behind numbers nobody could read.
 */
export const machineQuotaSchema = z.object({
  plan: z.enum(["free", "plus"]),
  period_start: z.string(),
  period_end: z.string(),
  beeps_accepted: z.number().int(),
  beeps_limit: z.number().int().nullable(),
  exhausted: z.boolean(),
});
export type MachineQuota = z.infer<typeof machineQuotaSchema>;

export const pushReachabilityResponseSchema = z.object({
  active_device_count: z.number().int(),
  stale_device_count: z.number().int(),
  most_recent_registration_at: z.string().nullable(),
  /**
   * When an ACTIVE device last CHECKED IN — the real heartbeat (birdybeep-2x9s), stamped by the
   * app from the foreground. The field above it is a REGISTRATION time that never moves, which is
   * why `doctor` had no staleness check at all until this existed: a rule keyed on a frozen value
   * calls an actively-used account broken.
   *
   * Three answers, and keeping them apart is the whole reason this row can be trusted:
   *   • a timestamp — some active device on the account ran the app then;
   *   • `null`      — devices exist but NONE has ever checked in. Almost always an app build older
   *                   than the heartbeat (the backend deploys weeks before an App Store build
   *                   lands) — an absence of evidence, never staleness;
   *   • absent      — a backend deployed before 2x9s: a different absence again.
   *
   * OPTIONAL for the same reason as `quota`, and it must stay optional (2x9s). See below.
   */
  most_recent_check_in_at: z.string().nullable().optional(),
  last_delivery: z.object({ status: z.string(), at: z.string() }).nullable(),
  /**
   * OPTIONAL, and it must stay optional (58l). The current worker always sends it, but a CLI is
   * installed for months against whatever backend is deployed: hard-requiring a field added
   * today turns "your server is one release behind" into `unrecognized response`, i.e. a
   * fabricated failure in the one command whose whole job is to name the real one. Absent → the
   * quota row says the server does not report it, and stays informational.
   */
  quota: machineQuotaSchema.optional(),
});
export type PushReachabilityResponse = z.infer<typeof pushReachabilityResponseSchema>;
