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
