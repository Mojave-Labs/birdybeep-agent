/**
 * CORE-SENDER (part 1): PARITY of the mirrored error envelope with the product
 * `packages/schemas/api.ts` (ticket 95e). Vendored codes + a canonical envelope
 * fixture validate identically here; drift fails. Update the vendored values in
 * lockstep whenever the product api contract changes (§16.4).
 */
import { describe, expect, it } from "vitest";

import { ERROR_CODES, ERROR_STATUS, errorCodeSchema, errorEnvelopeSchema } from "./index";

// VENDORED from the product packages/schemas/api.ts — keep identical (§16.4).
const PRODUCT_ERROR_CODES = [
  "validation_failed",
  "unauthorized",
  "forbidden",
  "token_revoked",
  "not_found",
  "payload_too_large",
  "rate_limited",
  "quota_exceeded",
  "internal_error",
];

describe("error envelope parity (§13.4)", () => {
  it("the code set mirrors the product exactly, in order", () => {
    expect([...ERROR_CODES]).toEqual(PRODUCT_ERROR_CODES);
    expect([...errorCodeSchema.options]).toEqual(PRODUCT_ERROR_CODES);
  });

  it("parses a full and a minimal error envelope", () => {
    const full = {
      error: { code: "validation_failed", message: "bad input", details: { field: "email" } },
      requestId: "req_123",
    };
    expect(errorEnvelopeSchema.parse(full)).toEqual(full);
    expect(
      errorEnvelopeSchema.safeParse({ error: { code: "not_found", message: "x" } }).success,
    ).toBe(true);
  });

  it("rejects an out-of-set code and a malformed envelope", () => {
    expect(errorEnvelopeSchema.safeParse({ error: { code: "kaboom", message: "x" } }).success).toBe(
      false,
    );
    expect(errorEnvelopeSchema.safeParse({ error: { message: "x" } }).success).toBe(false);
    expect(errorEnvelopeSchema.safeParse({}).success).toBe(false);
  });

  it("every code has a canonical HTTP status >= 400", () => {
    for (const code of ERROR_CODES) {
      expect(typeof ERROR_STATUS[code]).toBe("number");
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});
