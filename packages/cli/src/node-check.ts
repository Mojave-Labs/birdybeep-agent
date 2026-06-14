/**
 * Node version guard (§16.3): the CLI installs into developers' machines, so it fails
 * gracefully with a clear message on an unsupported Node rather than crashing on a missing
 * API. The minimum here matches every package's `engines.node`.
 */
export const MIN_NODE_MAJOR = 20;

/** Parse the major version from a `process.versions.node` string (e.g. "20.11.0" → 20). */
export function parseNodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version);
  return match ? Number(match[1]) : null;
}

/** A clear error message if `version` is below the supported range, else null. */
export function nodeVersionError(version: string): string | null {
  const major = parseNodeMajor(version);
  if (major === null) return null; // unparseable → don't block (best-effort)
  return major < MIN_NODE_MAJOR
    ? `birdybeep requires Node ${MIN_NODE_MAJOR}+ (you have ${version}). Please upgrade Node and retry.`
    : null;
}
