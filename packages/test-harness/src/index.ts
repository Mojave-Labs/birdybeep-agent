/**
 * @birdybeep/test-harness — the internal E2E spine every adapter test hangs off.
 *
 * Hermetic temp-HOME sandbox, a swappable event sink, real-shaped harness
 * fixtures, and contract assertions (event_type mapping, path hashing, payload
 * redaction/truncation, token provenance, non-destructive + idempotent +
 * byte-for-byte-reversible config patching, no-token-in-repo). Never published.
 *
 * Adapters import these helpers in their own vitest suites and supply their real
 * `install`/`normalizeEvent`; the reference adapter here proves the rig works
 * today (before agent-core and the real adapters exist).
 */
export * from "./contract";
export * from "./example-adapter";
export * from "./fixtures";
export * from "./sandbox";
export * from "./sink";
