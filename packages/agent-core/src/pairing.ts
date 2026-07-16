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
  /**
   * PKCE S256 challenge (dgxd) = BASE64URL(SHA-256(code_verifier)) — a PUBLIC commitment that
   * binds this session to the CLI that STARTED it. When present, the product's `/pair/token`
   * REQUIRES a matching `code_verifier`, so a token can only be redeemed by the initiating CLI.
   * OPTIONAL both ways: a legacy CLI omits it (keeps device_code-only behavior), a current CLI
   * always sends it. The `.max(200)` bound mirrors the product (it persists the challenge verbatim
   * into `pairing_sessions.cli_public_key`); a real S256 challenge is 43 chars. `.catch(undefined)`
   * matches the accept-and-ignore leniency of the other optional fields. See `pkce.ts`.
   */
  code_challenge: z.string().min(1).max(200).optional().catch(undefined),
});

/** `POST /v1/pair/token` — UNAUTHENTICATED; the CLI exchanges its device code (polled). */
export const pairTokenRequestSchema = z.object({
  device_code: z.string().min(1),
  machine_fingerprint: z.string().optional().catch(undefined),
  /**
   * PKCE verifier (dgxd) — the random secret whose SHA-256 the CLI committed to via
   * `code_challenge` on `/pair/start`. When the session was started WITH a challenge the product
   * REQUIRES this and checks `sha256Base64Url(verifier) === stored challenge`; only the initiating
   * CLI holds it. Held in memory for the duration of `birdybeep pair` and NEVER written to disk.
   * OPTIONAL so legacy (no-challenge) sessions are unaffected. `.catch(undefined)` so a malformed
   * value fails the proof cleanly rather than 400-ing on shape.
   */
  code_verifier: z.string().min(1).optional().catch(undefined),
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
  /**
   * The account this machine was just bound to (dgxd) — so the CLI can SHOW the approving
   * identity ("paired to becs@…") and a human notices a wrong-account approval. Optional/additive:
   * older CLIs ignore it (zod strips unknown keys), so surfacing it is backward compatible.
   */
  approved_by_email: z.string().optional(),
});

export type PairStartRequest = z.infer<typeof pairStartRequestSchema>;
export type PairTokenRequest = z.infer<typeof pairTokenRequestSchema>;
export type PairStartResponse = z.infer<typeof pairStartResponseSchema>;
export type PairTokenResponse = z.infer<typeof pairTokenResponseSchema>;
