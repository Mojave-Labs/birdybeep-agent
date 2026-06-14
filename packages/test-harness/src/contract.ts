/**
 * Contract assertions — the difference between "an event arrived" and "the RIGHT
 * event arrived, with the privacy invariants honored." Framework-agnostic: each
 * helper throws `AssertionError` on failure, so it works from any test runner.
 *
 * These are intentionally structural (no import of `agent-core`, which lands
 * later): they assert event_type mapping, the 16 KB size cap, that raw
 * paths/secrets never appear, that config patching is non-destructive +
 * idempotent + byte-for-byte reversible, and that no token leaks into the repo.
 * Once `agent-core` ships its zod schema, the real adapter additionally validates
 * the full §10.2 shape — these checks remain the privacy/behavior backstop.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { DeliveredEvent, EventSink } from "./sink";

/** Mirrors the product's MAX_AGENT_EVENT_BYTES (§13.5). The harness owns its own copy. */
export const EVENT_SIZE_CAP_BYTES = 16 * 1024;

/** Directories never worth scanning when looking for leaked secrets. */
const SCAN_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  ".turbo",
  ".beads",
  ".dolt",
  "coverage",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The delivered event body as a record (throws if it is not a JSON object). */
export function eventBody(delivered: DeliveredEvent): Record<string, unknown> {
  const rec = asRecord(delivered.body);
  assert.ok(rec, `delivered body is not a JSON object: ${JSON.stringify(delivered.body)}`);
  return rec;
}

export interface DeliveredExpectation {
  /** Required: the normalized event_type the adapter must have mapped to (§10.1). */
  eventType: string;
  /** Optional: harness id (§9.5–9.7). */
  harness?: string;
  /** Optional: the source session id the payload carried. */
  sourceSessionId?: string;
  /** Path the event must have been POSTed to (default `/v1/agent-events`). */
  path?: string;
}

/**
 * Assert that exactly one delivered event matches the expectation and return it.
 * Matches on event_type (+ optional harness / source_session_id / path).
 */
export function assertDelivered(sink: EventSink, expected: DeliveredExpectation): DeliveredEvent {
  const matches = sink.received().filter((e) => {
    if (expected.path !== undefined && e.path !== expected.path) return false;
    const body = asRecord(e.body);
    if (!body) return false;
    if (body["event_type"] !== expected.eventType) return false;
    if (expected.harness !== undefined && body["harness"] !== expected.harness) return false;
    if (
      expected.sourceSessionId !== undefined &&
      body["source_session_id"] !== expected.sourceSessionId
    ) {
      return false;
    }
    return true;
  });
  assert.equal(
    matches.length,
    1,
    `expected exactly 1 delivered event_type="${expected.eventType}", got ${matches.length} ` +
      `(of ${sink.received().length} total delivered)`,
  );
  return matches[0]!;
}

/** Assert the serialized event body is within the §13.5 size cap. */
export function assertWithinSizeCap(delivered: DeliveredEvent, max = EVENT_SIZE_CAP_BYTES): void {
  const bytes = Buffer.byteLength(JSON.stringify(delivered.body), "utf8");
  assert.ok(bytes <= max, `event body is ${bytes} bytes, exceeds cap of ${max}`);
}

/**
 * Assert none of `rawValues` (absolute paths, secrets, the real home dir) appear.
 * Scans the body AND the request headers by default — a path leaked into a custom
 * header is just as bad as one in the body. Pass `scope: "body"` for values that
 * legitimately live in a header (e.g. the Bearer token in `authorization`).
 */
export function assertNoRawValues(
  delivered: DeliveredEvent,
  rawValues: readonly string[],
  opts: { scope?: "body" | "body+headers" } = {},
): void {
  const scope = opts.scope ?? "body+headers";
  let serialized = JSON.stringify(delivered.body);
  if (scope === "body+headers") serialized += `\n${JSON.stringify(delivered.headers)}`;
  for (const value of rawValues) {
    if (value.length === 0) continue;
    assert.ok(
      !serialized.includes(value),
      `delivered event leaked a raw value that must be hashed/redacted (${scope}): ${JSON.stringify(value)}`,
    );
  }
}

/** Assert specific absolute paths were hashed/stripped: none appear raw (body + headers). */
export function assertPathsHashed(delivered: DeliveredEvent, rawPaths: readonly string[]): void {
  assertNoRawValues(delivered, rawPaths);
}

/** A POSIX (`/a/b…`) or Windows (`C:\a…`) absolute path with at least two segments. */
const ABSOLUTE_PATH_RE = /\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z]:[\\/][A-Za-z0-9_.\\/-]+/;

/**
 * Catch-all for path leaks the test did not enumerate: assert the event BODY
 * contains no absolute-path-shaped string at all. Stronger than {@link
 * assertPathsHashed} (which only checks known values) — a real adapter that
 * accidentally includes any raw filesystem path in a sent field is caught here.
 */
export function assertNoAbsolutePaths(delivered: DeliveredEvent): void {
  const serialized = JSON.stringify(delivered.body);
  const match = ABSOLUTE_PATH_RE.exec(serialized);
  assert.ok(
    match === null,
    `delivered event body contains an un-hashed absolute path: ${JSON.stringify(match?.[0])}`,
  );
}

/** Assert the sink received EXACTLY `count` events total (catches extra/duplicate fires). */
export function assertExactDeliveredCount(sink: EventSink, count: number): void {
  assert.equal(
    sink.received().length,
    count,
    `expected exactly ${count} delivered event(s), got ${sink.received().length}`,
  );
}

/** Assert a string field on the delivered event was truncated to at most `maxLen` chars. */
export function assertTruncated(delivered: DeliveredEvent, field: string, maxLen: number): void {
  const value = eventBody(delivered)[field];
  assert.ok(typeof value === "string", `field "${field}" is not a string`);
  assert.ok(
    value.length <= maxLen,
    `field "${field}" was not truncated: ${value.length} > ${maxLen}`,
  );
}

/** The Bearer token the adapter sent (from the `authorization` header), if any. */
export function deliveredBearerToken(delivered: DeliveredEvent): string | undefined {
  const auth = delivered.headers["authorization"];
  return auth?.toLowerCase().startsWith("bearer ") ? auth.slice("bearer ".length) : undefined;
}

// ---------------------------------------------------------------------------
// Config-tree capture/diff: non-destructive install, idempotency, byte-for-byte
// uninstall. A "tree" is { relativePath -> sha256(content) } under a directory.
// ---------------------------------------------------------------------------

export type Tree = Record<string, string>;

function walkFiles(root: string, dir: string, out: Tree): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SCAN_IGNORE.has(entry.name)) continue;
      walkFiles(root, abs, out);
    } else if (entry.isFile()) {
      const rel = relative(root, abs).split(sep).join("/");
      out[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  }
}

/** Snapshot a directory tree as { relativePath -> content hash }. Missing dir → {}. */
export function captureTree(dir: string): Tree {
  const out: Tree = {};
  if (existsSync(dir)) walkFiles(dir, dir, out);
  return out;
}

export interface TreeDelta {
  added: string[];
  removed: string[];
  changed: string[];
}

/** What changed between two {@link captureTree} snapshots (sorted relative paths). */
export function diffTree(before: Tree, after: Tree): TreeDelta {
  const delta: TreeDelta = { added: [], removed: [], changed: [] };
  for (const path of Object.keys(after)) {
    if (!(path in before)) delta.added.push(path);
    else if (before[path] !== after[path]) delta.changed.push(path);
  }
  for (const path of Object.keys(before)) {
    if (!(path in after)) delta.removed.push(path);
  }
  delta.added.sort();
  delta.removed.sort();
  delta.changed.sort();
  return delta;
}

/**
 * Assert an install touched ONLY what it was allowed to: the delta between
 * before/after matches the expected added/changed/removed paths exactly. This is
 * how "only BirdyBeep-managed entries added, existing config preserved" is proven
 * (any unexpected removed/changed path means the install was destructive).
 */
export function assertTreeDelta(
  before: Tree,
  after: Tree,
  expected: { added?: string[]; removed?: string[]; changed?: string[] },
): void {
  const actual = diffTree(before, after);
  assert.deepEqual(actual, {
    added: [...(expected.added ?? [])].sort(),
    removed: [...(expected.removed ?? [])].sort(),
    changed: [...(expected.changed ?? [])].sort(),
  });
}

/** Assert two trees are byte-for-byte identical (idempotent re-install, or uninstall-restores). */
export function assertTreesEqual(before: Tree, after: Tree, message?: string): void {
  assert.deepEqual(after, before, message);
}

// ---------------------------------------------------------------------------
// Token-leak scan.
// ---------------------------------------------------------------------------

/** Find the workspace root by walking up for pnpm-workspace.yaml. */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return startDir; // hit filesystem root; fall back
    dir = parent;
  }
}

function scanForString(dir: string, needle: string, hits: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SCAN_IGNORE.has(entry.name)) continue;
      scanForString(join(dir, entry.name), needle, hits);
    } else if (entry.isFile()) {
      const abs = join(dir, entry.name);
      try {
        if (readFileSync(abs, "utf8").includes(needle)) hits.push(abs);
      } catch {
        // unreadable/binary — skip
      }
    }
  }
}

/**
 * Assert a durable token NEVER appears in any repo-local file (§7.3 / §19.2).
 * Tokens live only in the OS keychain or a strict-perm file in the user config
 * dir (inside the sandbox HOME) — never committed, never repo-relative.
 */
export function assertNoTokenInRepo(repoRoot: string, token: string): void {
  assert.ok(token.length > 0, "refusing to scan for an empty token");
  const hits: string[] = [];
  scanForString(repoRoot, token, hits);
  assert.equal(hits.length, 0, `token leaked into repo-local file(s): ${hits.join(", ")}`);
}

/**
 * Assert the user's REAL home dir was not touched by the install. Pass paths that
 * are UNIQUELY created by BirdyBeep (e.g. the `*.birdybeep-backup` file, the token
 * file) — never paths that can legitimately pre-exist (like `.claude/settings.json`,
 * which a real Claude Code user already has). If the install had escaped the
 * sandbox into the real home, these uniquely-ours artifacts would appear there.
 */
export function assertRealHomeUntouched(
  realHome: string,
  birdybeepArtifactRelPaths: readonly string[],
): void {
  for (const rel of birdybeepArtifactRelPaths) {
    const abs = join(realHome, rel);
    assert.ok(!existsSync(abs), `install escaped the sandbox and wrote to the real home: ${abs}`);
  }
}
