/**
 * Integration-status report wire contract (§8.8/§13.4) — MIRRORED from the product
 * `packages/schemas/integrations.ts`. `birdybeep agent install` / `doctor` report each
 * harness's install/health state in ONE batched `POST /v1/integrations/status` call.
 * LOCKSTEP (§16.4): additive to and independent of the §10.2 event payload.
 *
 * Identity (machine + user) is derived server-side from the machine token, never from this
 * body. `last_status_payload` is diagnostic-only JSON (metadata only — never notification
 * title/body or plaintext paths, §15.2), size-capped so an oversized blob fails validation.
 */
import { z } from "zod";

import { INTEGRATION_STATUSES } from "./adapter";
import { harnessSchema } from "./primitives";

/** §8.8 integration status, as a validator (mirrors the product's `integrationStatusSchema`). */
export const integrationStatusSchema = z.enum(INTEGRATION_STATUSES);

/** A machine reports a handful of harnesses per call (§8.8). */
export const STATUS_REPORT_MAX_ITEMS = 16;
/** Diagnostic payload cap (§13.5): an oversized `last_status_payload` → 400. */
export const STATUS_REPORT_MAX_PAYLOAD_BYTES = 2048;

/** One harness's reported install/health state. */
export const integrationStatusItemSchema = z.object({
  harness: harnessSchema,
  status: integrationStatusSchema,
  harness_version: z.string().max(64).optional(),
  adapter_version: z.string().max(64).optional(),
  last_status_payload: z
    .unknown()
    .optional()
    .refine((v) => v === undefined || JSON.stringify(v).length <= STATUS_REPORT_MAX_PAYLOAD_BYTES, {
      message: "last_status_payload too large",
    }),
});

/** The batched `POST /v1/integrations/status` request body. */
export const integrationStatusReportSchema = z.object({
  integrations: z.array(integrationStatusItemSchema).min(1).max(STATUS_REPORT_MAX_ITEMS),
});

/**
 * The response: the server echoes each harness's EFFECTIVE status (e.g. it forces
 * Codex → `needs_trust` until the first event regardless of what the CLI reported).
 * Tolerant of extra fields so a server addition won't break parsing.
 */
export const integrationStatusResponseSchema = z.object({
  integrations: z.array(
    z.object({ harness: harnessSchema, status: integrationStatusSchema }).catchall(z.unknown()),
  ),
});

export type IntegrationStatusItem = z.infer<typeof integrationStatusItemSchema>;
export type IntegrationStatusReport = z.infer<typeof integrationStatusReportSchema>;
export type IntegrationStatusResponse = z.infer<typeof integrationStatusResponseSchema>;
