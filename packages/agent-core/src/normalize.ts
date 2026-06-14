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
import { createHash, randomUUID } from "node:crypto";

import { type BirdyBeepAgentEvent, birdyBeepAgentEventSchema } from "./event";
import { MAX_AGENT_EVENT_BYTES } from "./primitives";

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

/** Stable, irreversible token for a hashed value. Same input → same hash across runs. */
function hashToken(value: string): string {
  return `h_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

/** A POSIX (`/a/b…`) or Windows (`C:\a…`) absolute path with ≥2 segments. */
const ABSOLUTE_PATH_RE = /(?:\/[A-Za-z0-9_.-]+){2,}|[A-Za-z]:(?:[\\/][A-Za-z0-9_. -]+)+/g;

/** Secret-shaped substrings → replaced wholesale (best-effort; truncation is the backstop). */
const SECRET_RES: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(?:bearer|token|secret|password|passwd|api[_-]?key)\b\s*[:=]\s*\S+/gi, // key=value secrets
];

/** Replace every absolute path in a string with a stable hash (no raw path survives). */
export function scrubAbsolutePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH_RE, (match) => hashToken(match));
}

/** Replace secret-looking substrings with a redaction marker. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_RES) out = out.replace(re, "[redacted]");
  return out;
}

/** Truncate to `max` chars with an ellipsis marker. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Hash an absolute path so it never leaves the machine raw (§14.5). */
export function hashPath(path: string): string {
  return hashToken(path);
}

/** Full string-cleaning pipeline: scrub paths → redact secrets → truncate. */
function cleanString(text: string, max: number): string {
  return truncate(redactSecrets(scrubAbsolutePaths(text)), max);
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
