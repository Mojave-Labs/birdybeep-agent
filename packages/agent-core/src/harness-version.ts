/**
 * Shared guard for the `harness_version` wire field (birdybeep-agent-gcgp.7).
 *
 * Adapters read the version the harness reports about ITSELF — from an env var it exports
 * into hook children, from the hook payload, or from the session transcript it just wrote.
 * Every one of those sources is attacker-INFLUENCEABLE in the hostile-repo threat model the
 * adapters already assume (a repo-local `.envrc`/direnv can set any env var a hook inherits;
 * a rollout file is on disk). So the value never reaches the draft event unvalidated: it must
 * look like a version and nothing else.
 *
 * The shape is deliberately narrow — alphanumerics plus `.`, `-` and `+` — which admits every
 * real form observed (`2.1.229`, `0.148.0-alpha.9`, `2026.07.09-a3815c0`, `1.0.78`, and semver
 * build metadata) and rejects anything with whitespace, path separators, quotes, underscores
 * or control characters. Underscores are excluded on purpose: no released harness version uses
 * one, and it is the separator in Claude Code's `AI_AGENT=claude-code_2-1-229_harness`, so
 * forwarding that raw value instead of the decoded version fails here loudly. The 64-char cap
 * matches the product's `integrations` schema (`harness_version: z.string().max(64)`), so a
 * value that passes here is also reportable through `POST /v1/integrations/status`.
 *
 * This is a SHAPE guard, not a privacy control: the normalizer still redacts + truncates the
 * field like every other string. Its job is to stop a junk/hostile env var from riding a
 * legitimate field off the machine, and to keep `(none)` meaning "the harness didn't say"
 * rather than "the harness said something unusable".
 */

/** Longest accepted version string — matches the product `integrations` schema's max(64). */
export const HARNESS_VERSION_MAX_CHARS = 64;

/** Version-shaped: starts alphanumeric, then alphanumerics and `.`, `-`, `+` only. */
const HARNESS_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/**
 * Return `value` when it is a plausible harness version string, else `undefined`.
 * Trims surrounding whitespace first (a `--version` probe or env export may carry a newline);
 * INTERNAL whitespace still fails, because no version has any.
 */
export function sanitizeHarnessVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > HARNESS_VERSION_MAX_CHARS) return undefined;
  return HARNESS_VERSION_RE.test(trimmed) ? trimmed : undefined;
}
