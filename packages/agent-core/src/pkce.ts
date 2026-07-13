/**
 * PKCE (RFC 7636) S256 helpers for the pairing device-code flow (dgxd, §7.2/§13.4).
 *
 * The CLI generates a high-entropy random `code_verifier`, sends only its `code_challenge`
 * (BASE64URL(SHA-256(verifier))) on `POST /v1/pair/start`, and later proves possession of the
 * verifier on `POST /v1/pair/token`. This binds the token mint to the CLI that STARTED the
 * session: an interceptor of the short-lived device_code can't redeem it without the verifier.
 *
 * The challenge transform MUST match the product server byte-for-byte or its comparison
 * (`sha256Base64Url(verifier) === stored challenge`) fails. The product computes it as
 * `btoa(SHA-256 bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')` — i.e. base64url
 * with NO padding. Node's `"base64url"` digest encoding is exactly that (RFC 4648 §5, unpadded),
 * and SHA-256 over the UTF-8 bytes matches the server's `TextEncoder().encode(verifier)`.
 *
 * The verifier is a short-lived SECRET held only in memory for the duration of `birdybeep pair`;
 * it is NEVER persisted to disk or the token store (§15.1). Only the public challenge is transported.
 */
import { createHash, randomBytes } from "node:crypto";

/**
 * Entropy for the verifier. 32 random bytes → 256 bits, encoded as a 43-char base64url string —
 * comfortably inside RFC 7636's 43–128 char verifier range and the product's length bounds.
 */
export const PKCE_VERIFIER_BYTES = 32;

/**
 * Generate a cryptographically-random, URL-safe PKCE `code_verifier` (unreserved chars only:
 * base64url has no `+`, `/`, or `=` padding). Fresh per `birdybeep pair` invocation.
 */
export function generateCodeVerifier(bytes: number = PKCE_VERIFIER_BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Derive the S256 `code_challenge` = BASE64URL(SHA-256(verifier)), matching the product's
 * `sha256Base64Url` exactly (unpadded base64url over the UTF-8 verifier bytes). The value is a
 * public commitment — safe to transport — that reveals nothing about the verifier.
 */
export function deriveCodeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}
