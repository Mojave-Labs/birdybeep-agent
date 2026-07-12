/**
 * normalizeEvent + redaction/truncation/path-hashing (§9.2, §15.1–15.3).
 *
 * This is where the LOCAL privacy rules run before anything leaves the machine:
 * absolute paths are hashed, secret-looking strings are redacted, every string is
 * truncated to a bounded length, and the serialized payload is forced under the
 * §13.5 size cap. The output always validates as a {@link BirdyBeepAgentEvent} or
 * a {@link NormalizeError} is thrown — never a partially-valid event. Pure: no I/O,
 * no logging of raw content (§15.2).
 */
import { createHmac, randomUUID } from "node:crypto";

import { type BirdyBeepAgentEvent, birdyBeepAgentEventSchema } from "./event";
import { MAX_AGENT_EVENT_BYTES } from "./primitives";
import { getInstallSalt } from "./salt";

/** Per-field truncation caps (agent-local privacy choice; the 16 KB total is the lockstep cap). */
export const TITLE_MAX_CHARS = 200;
export const BODY_MAX_CHARS = 2000;
export const METADATA_VALUE_MAX_CHARS = 500;
export const METADATA_MAX_KEYS = 64;
export const METADATA_MAX_DEPTH = 4;
export const LABEL_MAX_CHARS = 120;

/** Thrown when input cannot be coerced into a valid, under-cap event. */
export class NormalizeError extends Error {
  constructor(
    message: string,
    readonly issues?: readonly unknown[],
  ) {
    super(message);
    this.name = "NormalizeError";
  }
}

export interface NormalizeOptions {
  /** Injectable clock for deterministic tests. Default: real wall clock (ISO). */
  now?: () => string;
  /** Injectable id generator for deterministic tests. Default: `evt_local_<uuid>`. */
  generateId?: () => string;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Stable, irreversible token for a hashed value. Same input → same hash *for this
 * install*. Keyed by the per-install {@link getInstallSalt} secret (birdybeep-agent-ofi):
 * a bare `sha256(path)` is identical on every machine, so an attacker holding the
 * stored hashes reverses low-entropy paths (`/Users/<name>/dev/<repo>`) by precompute.
 * HMAC-with-a-local-salt keeps the hash stable per machine (correlation still works)
 * while making that offline reversal require the salt, which never leaves the machine.
 * Truncated to 64 bits: the salt — not the digest width — is what defeats brute force.
 */
function hashToken(value: string): string {
  return `h_${createHmac("sha256", getInstallSalt()).update(value).digest("hex").slice(0, 16)}`;
}

// --- Absolute-path scrubbing (birdybeep-agent-yop) --------------------------------
// The invariant is ABSOLUTE: no raw absolute path (or path FRAGMENT) leaves the machine.
// A segment may contain internal spaces (`Client Work`, `Application Support`) so the WHOLE
// run is hashed; we match POSIX/`~`, Windows-drive (`C:\…`), and UNC (`\\server\share\…`)
// shapes; a single segment counts (`/etc`); and each root is anchored so it is not confused
// with a slash-operator or a URL.
//
// TWO POSIX leads (birdybeep-agent-yop glued-path fix):
//   • CLEAN lead — the root `/`/`~` sits at a boundary (start, space, `_`, `-`, `(`, …). One
//     segment is enough (`/etc`). Excludes a preceding alnum/`.`/`:`/`~`/slash, so `and/or`,
//     `v1.0/x`, and a `scheme://` authority are not treated as roots.
//   • GLUED lead — the root `/` is glued to `:` `@` or an alnum: `user@host:/Users/…` (scp),
//     `file:/Users/…`, `from/Users/…`, `9/Users/…`. These are the shapes that LEAKED — the
//     clean lead deliberately rejects those chars (to keep `and/or` out), which let a real
//     glued path through un-hashed. To avoid re-catching single-slash prose (`read/write`,
//     `1/2`, `TCP/IP`) a GLUED run must have ≥2 segments. It is not preceded by a slash, so a
//     `//host` URL authority is excluded here; genuine `http(s)://`/`ws(s)://` URLs are also
//     preserved wholesale by scrubAbsolutePaths before this runs (`https://ex.com/a/b/c` is
//     never touched even though `/a/b/c` is a ≥2-segment alnum-glued run).
// Deliberate trade-off (safe direction): trailing/interstitial prose after a path may be
// absorbed into the hash. Over-redaction is acceptable; leaking a path fragment is not.
const PATH_SEGMENT = String.raw`[^\s\\/]+(?: +[^\s\\/]+)*`;
// A single space-FREE segment. The glued lead uses this for its first two segments so a real
// path (`/Users/alice/…`) is recognised by its two adjacent slashes, while slash-separated prose
// (`read/write and/or 1/2`) — whose slash groups are split by SPACES — never forms one.
const PATH_SEGMENT_NS = String.raw`[^\s\\/]+`;
const POSIX_LEAD = String.raw`(?<![A-Za-z0-9.:~\\/])`;
// Glued root: preceded by `:` `@` or an alnum (the chars the clean lead rejects). Explicitly
// NOT `/`, so the `//host` authority of a `scheme://` URL is not admitted as a path here.
const POSIX_GLUE_LEAD = String.raw`(?<=[A-Za-z0-9:@])`;
/** Drive/UNC root must not follow an alphanumeric (rules out `fooC:\…`). */
const WINISH_LEAD = String.raw`(?<![A-Za-z0-9])`;
const ABSOLUTE_PATH_SRC = [
  // Windows drive: C:\a\b  or  C:/a/b
  `${WINISH_LEAD}` +
    String.raw`[A-Za-z]:[\\/]` +
    `${PATH_SEGMENT}(?:` +
    String.raw`[\\/]` +
    `${PATH_SEGMENT})*`,
  // UNC: \\server\share\...
  `${WINISH_LEAD}` +
    String.raw`\\\\` +
    `${PATH_SEGMENT}(?:` +
    String.raw`[\\/]` +
    `${PATH_SEGMENT})*`,
  // POSIX / home at a CLEAN boundary: /a/b c/d  or  ~/Library/Application Support (≥1 segment)
  `${POSIX_LEAD}~?/${PATH_SEGMENT}(?:/${PATH_SEGMENT})*`,
  // POSIX GLUED to `:`/`@`/alnum: user@host:/Users/…, file:/Users/…, from/Users/…. Needs two
  // space-free segments up front (`/Users/alice`) to distinguish a real path from single-slash
  // prose; further segments may then contain spaces (`/My Documents`), so the whole run hashes.
  `${POSIX_GLUE_LEAD}/${PATH_SEGMENT_NS}/${PATH_SEGMENT_NS}(?:/${PATH_SEGMENT})*`,
].join("|");
// `scheme://` web URLs are matched FIRST and preserved verbatim: their path is remote and the
// `/a/b/c` tail would otherwise read as a local path. Only genuine `://` authority forms are
// spared — `file:/…` and scp `host:/…` (no `//`) are NOT URLs and stay subject to the scrub.
const WEB_URL_SRC = String.raw`\b(?:https?|wss?):\/\/\S+`;
// Single pass: a web URL (capture group 1, kept as-is) OR an absolute path (hashed). The URL
// alternative wins wherever it starts, so a URL's path-shaped tail is never hashed.
const SCRUB_RE = new RegExp(`(${WEB_URL_SRC})|(?:${ABSOLUTE_PATH_SRC})`, "gi");

// --- Secret redaction (birdybeep-agent-zov) ---------------------------------------
// Redaction is the ONLY privacy control for secrets — truncation is NOT a backstop (a
// secret inside the first N chars survives a tail trim). So the detection has to be broad.
/** Secret-shaped substrings → replaced wholesale. */
const SECRET_RES: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, // PEM private key block
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g, // AWS temporary access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub PAT / OAuth / user-to-server / server-to-server / refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g, // GitLab PAT
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, // Anthropic API key
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style keys (sk-…, sk-proj-…)
  /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe secret/restricted/publishable keys
  /\bwhsec_[A-Za-z0-9]{10,}\b/g, // Stripe webhook signing secret
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g, // Google OAuth access token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack bot/user/... tokens
  /\bxapp-[0-9]-[A-Za-z0-9-]{10,}\b/g, // Slack app-level token
  /\bxoxe\.xox[bp]-[A-Za-z0-9-]{10,}\b/g, // Slack refresh/config tokens
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, // Slack incoming-webhook URL
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(?:bearer|token|secret|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*\S+/gi, // key=value secrets
];

/** Shannon entropy (bits per char) of a string. */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A contiguous token-shaped run (base64/hex/token alphabet). Only these are entropy-tested. */
const TOKEN_RUN_RE = /[A-Za-z0-9+/=_-]{28,}/g;
/** Length/entropy floor for the generic detector — tuned to catch AWS-secret / 32-hex-key */
/** shapes while leaving path hashes (`h_<16hex>`, 18 chars) and ordinary prose untouched. */
const HIGH_ENTROPY_MIN_BITS = 3.5;

/**
 * Catch high-entropy credentials the explicit patterns miss (AWS secret access keys,
 * bare 32/64-char hex or base64 API keys, random tokens). Requires BOTH a letter and a
 * digit and ≥3.5 bits/char over a ≥28-char run, so long identifiers / words / our own
 * path-hash tokens are not disturbed.
 */
function redactHighEntropyTokens(text: string): string {
  return text.replace(TOKEN_RUN_RE, (tok) => {
    if (!/[A-Za-z]/.test(tok) || !/[0-9]/.test(tok)) return tok;
    return shannonEntropy(tok) >= HIGH_ENTROPY_MIN_BITS ? "[redacted]" : tok;
  });
}

/**
 * Replace every absolute path in a string with a stable hash (no raw path survives).
 * `http(s)://` / `ws(s)://` URLs are matched and preserved verbatim first, so a URL's remote
 * `/a/b/c` tail is never mistaken for (and hashed as) a local path (birdybeep-agent-yop).
 */
export function scrubAbsolutePaths(text: string): string {
  return text.replace(SCRUB_RE, (match, url) => (url ? match : hashToken(match)));
}

/** Replace secret-looking substrings with a redaction marker (explicit shapes + entropy). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_RES) out = out.replace(re, "[redacted]");
  return redactHighEntropyTokens(out);
}

/**
 * Truncate to `max` chars with an ellipsis marker. This is a SIZE bound only — never a
 * privacy control. Redaction (above) must have already removed secrets/paths; a secret in
 * the first `max` chars would otherwise survive the trim (birdybeep-agent-zov).
 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Hash an absolute path so it never leaves the machine raw (§14.5). */
export function hashPath(path: string): string {
  return hashToken(path);
}

/**
 * Full string-cleaning pipeline: redact secrets → scrub paths → truncate.
 *
 * Secrets are redacted BEFORE paths are scrubbed (birdybeep-agent-yop/zov ordering fix):
 * base64 secret material can contain `/` and `+`, so a `+/a/b`-shaped run inside a token could
 * otherwise be PARTLY path-hashed before redactSecrets ran — splitting the secret, possibly
 * leaving a readable fragment or defeating the high-entropy detector (which needs a contiguous
 * ≥28-char run). Redacting first collapses the whole token to `[redacted]` before any path
 * scanning, so the two controls no longer interact order-dependently. Path hashes (`h_<16hex>`)
 * are produced AFTER redaction, so they are never fed to the entropy detector — and at 18 chars
 * sit below its 28-char floor regardless.
 */
function cleanString(text: string, max: number): string {
  return truncate(scrubAbsolutePaths(redactSecrets(text)), max);
}

/** Recursively sanitize an arbitrary metadata value, bounding depth/size and scrubbing strings. */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (isString(value)) return cleanString(value, METADATA_VALUE_MAX_CHARS);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= METADATA_MAX_DEPTH) return undefined; // collapse over-deep structures
  if (Array.isArray(value)) {
    return value.slice(0, METADATA_MAX_KEYS).map((v) => sanitizeValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n >= METADATA_MAX_KEYS) break;
      const cleaned = sanitizeValue(v, depth + 1);
      if (cleaned !== undefined) {
        out[cleanString(k, LABEL_MAX_CHARS)] = cleaned;
        n++;
      }
    }
    return out;
  }
  return undefined; // functions/symbols/etc. are dropped
}

function serializedBytes(event: BirdyBeepAgentEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

/** Deterministically shrink an over-cap event: drop metadata → harden body → harden title. */
function enforceSize(event: BirdyBeepAgentEvent): BirdyBeepAgentEvent {
  if (serializedBytes(event) <= MAX_AGENT_EVENT_BYTES) return event;
  const steps: BirdyBeepAgentEvent[] = [
    { ...event, metadata: undefined },
    { ...event, metadata: undefined, body: truncate(event.body, 256) },
    {
      ...event,
      metadata: undefined,
      body: truncate(event.body, 256),
      title: truncate(event.title, 120),
    },
  ];
  for (const candidate of steps) {
    if (serializedBytes(candidate) <= MAX_AGENT_EVENT_BYTES) return candidate;
  }
  throw new NormalizeError("event exceeds max payload size even after shrinking");
}

/**
 * Coerce raw adapter input into a privacy-safe, size-bounded, validated
 * {@link BirdyBeepAgentEvent}. Fills `event_id`/`occurred_at` defaults, hashes
 * absolute paths, redacts secrets, truncates strings, and enforces the size cap.
 * Throws {@link NormalizeError} if the result cannot be made valid + under-cap.
 */
export function normalizeEvent(input: unknown, opts: NormalizeOptions = {}): BirdyBeepAgentEvent {
  const rec = asRecord(input);
  const ws = asRecord(rec["workspace"]);
  const machine = asRecord(rec["machine"]);

  const candidate: Record<string, unknown> = {
    event_id:
      isString(rec["event_id"]) && rec["event_id"].length > 0
        ? rec["event_id"]
        : (opts.generateId?.() ?? `evt_local_${randomUUID()}`),
    event_type: rec["event_type"],
    occurred_at:
      isString(rec["occurred_at"]) && rec["occurred_at"].length > 0
        ? rec["occurred_at"]
        : (opts.now?.() ?? new Date().toISOString()),
    harness: rec["harness"],
    // source_session_id is a key (§10.3) — keep it stable, but never let a raw path through.
    source_session_id: isString(rec["source_session_id"])
      ? scrubAbsolutePaths(rec["source_session_id"])
      : rec["source_session_id"],
    machine: {
      label: isString(machine["label"])
        ? cleanString(machine["label"], LABEL_MAX_CHARS)
        : machine["label"],
      os: isString(machine["os"]) ? cleanString(machine["os"], LABEL_MAX_CHARS) : machine["os"],
    },
    workspace: {
      // cwd is an absolute path → always hashed (§15: no absolute path leaves the machine).
      cwd: isString(ws["cwd"]) ? hashPath(ws["cwd"]) : ws["cwd"],
    },
    status: rec["status"],
    title: isString(rec["title"]) ? cleanString(rec["title"], TITLE_MAX_CHARS) : rec["title"],
    body: isString(rec["body"]) ? cleanString(rec["body"], BODY_MAX_CHARS) : rec["body"],
  };

  if (isString(rec["harness_version"])) {
    candidate["harness_version"] = cleanString(rec["harness_version"], LABEL_MAX_CHARS);
  }
  // Safe workspace labels are kept (cleaned), per §14.5.
  const wsOut = candidate["workspace"] as Record<string, unknown>;
  if (isString(ws["repo_name"])) wsOut["repo_name"] = cleanString(ws["repo_name"], LABEL_MAX_CHARS);
  if (isString(ws["branch"])) wsOut["branch"] = cleanString(ws["branch"], LABEL_MAX_CHARS);
  if (rec["metadata"] !== undefined) {
    candidate["metadata"] = sanitizeValue(rec["metadata"], 0);
  }

  const parsed = birdyBeepAgentEventSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new NormalizeError("normalized event failed schema validation", parsed.error.issues);
  }
  return enforceSize(parsed.data);
}
