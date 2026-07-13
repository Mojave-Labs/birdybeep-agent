/**
 * PKCE S256 helpers (dgxd) — the challenge transform MUST match the product server's
 * `sha256Base64Url` byte-for-byte or the `/pair/token` proof-of-possession check fails.
 * We pin it three ways: the RFC 7636 Appendix-B canonical vector, an INDEPENDENT
 * re-implementation of the server's exact transform, and verifier-shape invariants.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { deriveCodeChallengeS256, generateCodeVerifier, PKCE_VERIFIER_BYTES } from "./pkce";

/**
 * Independent re-implementation of the PRODUCT server's `sha256Base64Url` (packages/db/crypto.ts):
 * `btoa(SHA-256 bytes).replace(+→-, /→_).replace(/=+$/,'')`. Deriving the challenge a DIFFERENT
 * way than the code under test and asserting equality proves cross-repo transform parity.
 */
function serverSha256Base64Url(input: string): string {
  const digest = createHash("sha256").update(input, "utf8").digest();
  let s = "";
  for (const b of digest) s += String.fromCharCode(b);
  return Buffer.from(s, "binary")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("pkce S256", () => {
  it("matches the RFC 7636 Appendix-B canonical vector", () => {
    // verifier → challenge from RFC 7636 §B: the definitive S256 conformance vector.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(deriveCodeChallengeS256(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("matches the product server's sha256Base64Url transform for random verifiers", () => {
    for (let i = 0; i < 100; i++) {
      const v = generateCodeVerifier();
      expect(deriveCodeChallengeS256(v)).toBe(serverSha256Base64Url(v));
    }
  });

  it("produces a URL-safe, unpadded, high-entropy verifier", () => {
    const v = generateCodeVerifier();
    // base64url of 32 bytes → 43 chars, no `+`, `/`, or `=` padding (unreserved chars only).
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v).not.toContain("=");
    expect(v.length).toBe(43);
    expect(PKCE_VERIFIER_BYTES).toBe(32);
  });

  it("generates a fresh verifier each call (no reuse across pair invocations)", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()));
    expect(seen.size).toBe(50);
  });

  it("emits an unpadded base64url challenge (43 chars for SHA-256)", () => {
    const challenge = deriveCodeChallengeS256(generateCodeVerifier());
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32-byte digest → 43 unpadded chars
    expect(challenge).not.toContain("=");
  });
});
