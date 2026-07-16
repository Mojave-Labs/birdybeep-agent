/**
 * Mirrored wire-contract schemas (§13.4) accept the product's canonical shapes and enforce
 * the documented constraints — the lockstep guard for the pairing + integration-status
 * contracts the CLI builds/parses (independent of the §10.2 event payload).
 */
import { describe, expect, it } from "vitest";

import { INTEGRATION_STATUSES } from "./adapter";
import {
  AGENT_EVENT_ACCEPT_DECISIONS,
  agentEventDecisionSchema,
  agentEventsResponseSchema,
} from "./event";
import {
  integrationStatusReportSchema,
  integrationStatusResponseSchema,
  integrationStatusResultSchema,
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

  it("mirrors the dgxd PKCE binding fields (optional both ways, lockstep with product)", () => {
    // /pair/start carries an optional S256 code_challenge; a malformed value is accept-and-ignored.
    expect(
      pairStartRequestSchema.safeParse({ machine_label: "m", code_challenge: "abc123" }).success,
    ).toBe(true);
    const start = pairStartRequestSchema.parse({ machine_label: "m", code_challenge: 123 });
    expect(start.code_challenge).toBeUndefined();
    // /pair/token carries an optional code_verifier (proof-of-possession); still valid without it.
    expect(
      pairTokenRequestSchema.safeParse({ device_code: "dc", code_verifier: "v" }).success,
    ).toBe(true);
    expect(pairTokenRequestSchema.safeParse({ device_code: "dc" }).success).toBe(true);
    // /pair/token response surfaces the optional approving identity; still valid without it.
    expect(
      pairTokenResponseSchema.safeParse({
        machine_token: "bbm_x",
        machine_id: "mac_1",
        approved_by_email: "becs@example.com",
      }).success,
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

  // kje4 — the RESPONSE the worker returns and this repo (report-status / status / doctor)
  // parses: `{ integrations: [{ harness, status, updated }] }`. Mirrored field-for-field
  // from the product `integrationStatusResponseSchema`; `updated` is REQUIRED. The live
  // 200-route parse (real CLI ↔ worker) is the deferred xrepo-e2e gate.
  it("parses a representative multi-harness response (effective status + updated true/false)", () => {
    const parsed = integrationStatusResponseSchema.safeParse({
      integrations: [
        { harness: "claude_code", status: "installed", updated: true },
        // Codex `installed` is echoed as the canonicalized `needs_trust` (§9.6/§21.2);
        // a revoked/skipped integration comes back `updated: false`.
        { harness: "codex", status: "needs_trust", updated: false },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      integrations: [
        { harness: "claude_code", status: "installed", updated: true },
        { harness: "codex", status: "needs_trust", updated: false },
      ],
    });
  });

  it("rejects an unknown harness, an unknown status, and a missing `updated` flag", () => {
    expect(
      integrationStatusResponseSchema.safeParse({
        integrations: [{ harness: "nope", status: "installed", updated: true }],
      }).success,
    ).toBe(false);
    expect(
      integrationStatusResponseSchema.safeParse({
        integrations: [{ harness: "codex", status: "bogus", updated: true }],
      }).success,
    ).toBe(false);
    expect(
      integrationStatusResponseSchema.safeParse({
        integrations: [{ harness: "codex", status: "installed" }],
      }).success,
    ).toBe(false);
  });

  it("strips unknown result fields (exact shape, lockstep with the product's strict object)", () => {
    const parsed = integrationStatusResponseSchema.safeParse({
      integrations: [
        { harness: "codex", status: "needs_trust", updated: true, server_note: "extra" },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data.integrations[0]!).sort()).toEqual([
      "harness",
      "status",
      "updated",
    ]);
  });

  it("the result's status enum is DERIVED from the mirrored integration statuses (no drift)", () => {
    expect([...integrationStatusResultSchema.shape.status.options]).toEqual([
      ...INTEGRATION_STATUSES,
    ]);
  });
});

// kje4 — the agent-events RESPONSE (`{ accepted, decision }`, 202) parsed by CORE-SENDER.
// Mirrored field-for-field from the product `agentEventsResponseSchema`. The live 202-route
// parse is the deferred xrepo-e2e gate; sender.test.ts proves the wired code path.
describe("agent-events response schema (kje4) — CORE-SENDER lockstep contract", () => {
  it("parses the worker's accept ack for every accept-path decision", () => {
    for (const decision of AGENT_EVENT_ACCEPT_DECISIONS) {
      expect(agentEventsResponseSchema.safeParse({ accepted: true, decision }).success).toBe(true);
    }
  });

  it("rejects decisions the worker never puts in this shape (rate_limited/quota_rejected → 429 envelope)", () => {
    expect(
      agentEventsResponseSchema.safeParse({ accepted: true, decision: "rate_limited" }).success,
    ).toBe(false);
    expect(
      agentEventsResponseSchema.safeParse({ accepted: true, decision: "quota_rejected" }).success,
    ).toBe(false);
    expect(agentEventsResponseSchema.safeParse({ accepted: true, decision: "bogus" }).success).toBe(
      false,
    );
  });

  it("requires both `accepted` and `decision`", () => {
    expect(agentEventsResponseSchema.safeParse({ accepted: true }).success).toBe(false);
    expect(agentEventsResponseSchema.safeParse({ decision: "notified" }).success).toBe(false);
  });

  it("the accept-decision enum equals the exported constant (accept-path subset of the DB enum)", () => {
    expect([...agentEventDecisionSchema.options]).toEqual([...AGENT_EVENT_ACCEPT_DECISIONS]);
    expect([...AGENT_EVENT_ACCEPT_DECISIONS]).toEqual(["notified", "deduped", "suppressed"]);
  });
});
