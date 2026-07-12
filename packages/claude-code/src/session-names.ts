/**
 * Session-name state for the Claude Code adapter (sv1).
 *
 * WHY THIS EXISTS: users name their sessions (Claude Code `--name` / `/rename`), and the
 * push title should say WHICH session wants them. But `session_title` is exposed ONLY in
 * the SessionStart hook payload — it is NOT present in Stop/Notification/etc. (verified
 * against code.claude.com/docs/en/hooks.md, 2026-07-08). And every hook fire is a SEPARATE
 * PROCESS, so an in-memory cache cannot survive from SessionStart to a later Stop. The name
 * therefore has to be captured at SessionStart and parked on disk, keyed by session_id.
 *
 * The state is a cache, not config: tiny, disposable, and reconstructible (a lost name just
 * degrades the title to the 0r6 repo · branch lead). It lives next to the queue under the
 * user DATA dir — NEVER repo-local — with the same strict-perm discipline as the queue
 * (dir 0700, files 0600, atomic write-then-rename).
 *
 * Every method is BEST-EFFORT and swallows I/O errors: this runs on the harness's hot path,
 * so a full/locked/corrupt/unwritable state dir must degrade to "no name" — never throw into
 * or slow down the hook.
 *
 * Lifecycle (so state files can't accumulate): SessionEnd removes the entry, and any write
 * opportunistically sweeps entries past the TTL — so even sessions that die without a
 * SessionEnd (crash, kill -9) get collected.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { birdyBeepDataDir } from "@birdybeep/agent-core";

/**
 * How long a captured session name stays usable. Generous (a coding session can easily span
 * days) but bounded — a name is only ~100 bytes and the sweep keeps the dir from growing
 * without limit. Deliberately longer than the queue's 24h retention: dropping a name mid
 * session would silently regress the title, whereas a stale queued EVENT is actively harmful.
 */
export const SESSION_NAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Longest name we keep. Guards the title against a pathological /rename; the normalizer truncates too. */
export const SESSION_NAME_MAX_CHARS = 120;

export interface SessionNameStoreOptions {
  /** State directory (default `<dataDir>/claude-code/session-names`). Tests pass a sandbox path. */
  dir?: string;
  /** TTL in ms (default 7d). */
  ttlMs?: number;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
}

interface StoredName {
  name: string;
  updatedAt: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Trim + collapse a raw `session_title` into something safe to lead a push title with.
 * Returns undefined for blank/non-string input so the caller falls back to repo · branch.
 */
export function cleanSessionName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > SESSION_NAME_MAX_CHARS
    ? `${collapsed.slice(0, SESSION_NAME_MAX_CHARS - 1)}…`
    : collapsed;
}

/**
 * Disk-backed map of `session_id` → session name. One small file per session (hashed
 * filename), so concurrent sessions never contend on a single shared file.
 */
export class SessionNameStore {
  readonly dir: string;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: SessionNameStoreOptions = {}) {
    this.dir = options.dir ?? join(birdyBeepDataDir(), "claude-code", "session-names");
    this.#ttlMs = options.ttlMs ?? SESSION_NAME_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * One file per session. The session id is HASHED for the filename — it is opaque
   * harness-supplied input, so this both keeps it off the filesystem in the clear and
   * guarantees a safe, fixed-length name on every OS (no path separators / reserved chars).
   */
  #fileFor(sessionId: string): string {
    const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    return join(this.dir, `${key}.json`);
  }

  #ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.dir, 0o700); // repair a loose dir
  }

  /** Persist the name for a session (atomic, 0600). Sweeps expired entries. Never throws. */
  remember(sessionId: string, name: string): boolean {
    try {
      this.#ensureDir();
      const payload: StoredName = { name, updatedAt: this.#now() };
      const finalPath = this.#fileFor(sessionId);
      const tmpPath = `${finalPath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
      renameSync(tmpPath, finalPath); // atomic swap — a reader never sees a half-written file
      if (process.platform !== "win32") chmodSync(finalPath, 0o600);
      this.#sweep(); // opportunistic GC: collects sessions that never sent a SessionEnd
      return true;
    } catch {
      return false; // best-effort: a failed write must never break the harness
    }
  }

  /** The stored name for a session, or undefined (absent / expired / corrupt). Never throws. */
  lookup(sessionId: string): string | undefined {
    const path = this.#fileFor(sessionId);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(parsed)) return undefined;
      const name = parsed["name"];
      const updatedAt = parsed["updatedAt"];
      if (typeof name !== "string" || typeof updatedAt !== "number") return undefined;
      if (updatedAt < this.#now() - this.#ttlMs) {
        this.#remove(path); // expired → prune on read, then behave as if unnamed
        return undefined;
      }
      return cleanSessionName(name);
    } catch {
      return undefined; // missing / unreadable / corrupt → no name, no throw
    }
  }

  /** Drop a session's name (SessionEnd). Never throws. */
  forget(sessionId: string): void {
    this.#remove(this.#fileFor(sessionId));
  }

  #remove(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort */
    }
  }

  /** Delete entries past the TTL, so a machine that never emits SessionEnd can't accumulate files. */
  #sweep(): void {
    try {
      if (!existsSync(this.dir)) return;
      const cutoff = this.#now() - this.#ttlMs;
      for (const entry of readdirSync(this.dir)) {
        if (!entry.endsWith(".json")) continue; // ignore stray .tmp
        const path = join(this.dir, entry);
        try {
          const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
          const updatedAt = isRecord(parsed) ? parsed["updatedAt"] : undefined;
          // Corrupt (unparseable shape) or expired → collect it.
          if (typeof updatedAt !== "number" || updatedAt < cutoff) this.#remove(path);
        } catch {
          this.#remove(path); // unreadable/garbage → collect it
        }
      }
    } catch {
      /* best-effort */
    }
  }

  /** Whether the state dir has secure (0700) perms. True on Windows (ACL-based). */
  isSecure(): boolean {
    if (process.platform === "win32") return true;
    try {
      return (statSync(this.dir).mode & 0o077) === 0;
    } catch {
      return false;
    }
  }
}
