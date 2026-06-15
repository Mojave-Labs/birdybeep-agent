/**
 * Mirrored wire-contract schemas (§13.4) accept the product's canonical shapes and enforce
 * the documented constraints — the lockstep guard for the pairing + integration-status
 * contracts the CLI builds/parses (independent of the §10.2 event payload).
 */
import { describe, expect, it } from "vitest";

import {
  integrationStatusReportSchema,
  integrationStatusResponseSchema,
  STATUS_REPORT_MAX_ITEMS,
  STATUS_REPORT_MAX_PAYLOAD_BYTES,
} from "./integrations";
import {
  pairStartRequestSchema,
  pairStartResponseSchema,
  pairTokenRequestSchema,
  pairTokenResponseSchema,
} from "./pairing";

describe("pairing schemas", () => {
  it("requires machine_label on /pair/start and tolerates malformed optionals", () => {
    expect(pairStartRequestSchema.safeParse({ machine_label: "Dev Mac" }).success).toBe(true);
    expect(pairStartRequestSchema.safeParse({}).success).toBe(false); // missing required label
    // Optional advisory fields accept-and-ignore malformed values (.catch(undefined)).
    const parsed = pairStartRequestSchema.parse({ machine_label: "m", requested_scopes: 123 });
    expect(parsed.requested_scopes).toBeUndefined();
  });

  it("parses the bare /pair/start + /pair/token responses", () => {
    expect(
      pairStartResponseSchema.safeParse({
        device_code: "dc",
        user_code: "AB-12",
        qr_payload: "birdybeep://pair?code=AB-12",
        expires_at: "2026-06-14T00:10:00.000Z",
      }).success,
    ).toBe(true);
    expect(pairTokenRequestSchema.safeParse({ device_code: "dc" }).success).toBe(true);
    expect(
      pairTokenResponseSchema.safeParse({ machine_token: "bbm_x", machine_id: "mac_1" }).success,
    ).toBe(true);
  });
});

describe("integration-status schemas", () => {
  it("requires a non-empty batched integrations array within the item cap", () => {
    expect(
      integrationStatusReportSchema.safeParse({
        integrations: [{ harness: "codex", status: "needs_trust" }],
      }).success,
    ).toBe(true);
    expect(integrationStatusReportSchema.safeParse({ integrations: [] }).success).toBe(false);
    const tooMany = Array.from({ length: STATUS_REPORT_MAX_ITEMS + 1 }, () => ({
      harness: "codex" as const,
      status: "installed" as const,
    }));
    expect(integrationStatusReportSchema.safeParse({ integrations: tooMany }).success).toBe(false);
  });

  it("rejects an oversized last_status_payload", () => {
    const big = { blob: "x".repeat(STATUS_REPORT_MAX_PAYLOAD_BYTES + 1) };
    expect(
      integrationStatusReportSchema.safeParse({
        integrations: [{ harness: "codex", status: "installed", last_status_payload: big }],
      }).success,
    ).toBe(false);
  });

  it("parses the effective-status response and tolerates extra fields", () => {
    const parsed = integrationStatusResponseSchema.safeParse({
      integrations: [{ harness: "codex", status: "needs_trust", server_note: "until first event" }],
    });
    expect(parsed.success).toBe(true);
  });
});
