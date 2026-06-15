/**
 * Pairing handshake wire contract (§7.2/§13.4) — MIRRORED from the product
 * `packages/schemas/pairing.ts`. The CLI builds the `POST /v1/pair/start` + `/v1/pair/token`
 * requests and parses these (BARE, not `{ data }`-wrapped) responses. LOCKSTEP (§16.4):
 * additive to and independent of the §10.2 event payload — a change here is coordinated.
 *
 * Privacy (§15.1): codes are short-lived single-use, stored HASHED server-side; `qr_payload`
 * carries only the short `user_code`, NEVER a durable token; the `machine_token` from
 * `/pair/token` is shown once and only its peppered hash is persisted. Optional advisory
 * fields use `.catch(undefined)` to match the routes' accept-and-ignore leniency.
 *
 * (`/v1/pair/approve` is the signed-in MOBILE side — not mirrored here; the CLI never calls it.)
 */
import { z } from "zod";

import { isoDateTimeSchema } from "./primitives";

/** `POST /v1/pair/start` — UNAUTHENTICATED; the CLI opens a pairing session. */
export const pairStartRequestSchema = z.object({
  machine_label: z.string().min(1),
  os: z.string().optional().catch(undefined),
  cli_version: z.string().optional().catch(undefined),
  requested_scopes: z.array(z.string()).optional().catch(undefined),
});

/** `POST /v1/pair/token` — UNAUTHENTICATED; the CLI exchanges its device code (polled). */
export const pairTokenRequestSchema = z.object({
  device_code: z.string().min(1),
  machine_fingerprint: z.string().optional().catch(undefined),
});

/** `POST /v1/pair/start` response (bare). `qr_payload` encodes only the short `user_code`. */
export const pairStartResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  qr_payload: z.string(),
  expires_at: isoDateTimeSchema,
});

/** `POST /v1/pair/token` 201 response (bare). The durable token is issued exactly once. */
export const pairTokenResponseSchema = z.object({
  machine_token: z.string(),
  machine_id: z.string(),
});

export type PairStartRequest = z.infer<typeof pairStartRequestSchema>;
export type PairTokenRequest = z.infer<typeof pairTokenRequestSchema>;
export type PairStartResponse = z.infer<typeof pairStartResponseSchema>;
export type PairTokenResponse = z.infer<typeof pairTokenResponseSchema>;
