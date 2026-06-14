/**
 * Recent-event dedup ledger. Each harness hook fires in its OWN process (no daemon),
 * and a single user action can trigger more than one hook (e.g. Claude Code may emit
 * both PermissionRequest and Notification{permission_prompt} for one approval). To
 * avoid a double-beep, the ledger records recently-delivered event identities on disk
 * (strict perms, in the user data dir) and collapses a repeat of the same identity
 * within a short window. Best-effort + FAIL-OPEN: if the ledger can't be read/written
 * it allows the send (better a rare double-beep than a dropped notification).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { birdyBeepDataDir } from "./paths";

/** Default dedup window: collapse identical events seen within 10s. */
export const DEFAULT_DEDUP_WINDOW_MS = 10_000;

export interface RecentEventLedgerOptions {
  /** Ledger file path (default `<dataDir>/recent-events.json`). */
  path?: string;
  /** Dedup window in ms (default 10s). */
  windowMs?: number;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
}

interface LedgerEntry {
  id: string;
  ts: number;
}
function isLedgerEntry(v: unknown): v is LedgerEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>)["id"] === "string" &&
    typeof (v as Record<string, unknown>)["ts"] === "number"
  );
}

/** A canonical identity for an event: same harness + session + type = the "same beep". */
export function eventIdentity(event: {
  harness: string;
  source_session_id: string;
  event_type: string;
}): string {
  return `${event.harness}:${event.source_session_id}:${event.event_type}`;
}

export class RecentEventLedger {
  readonly path: string;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options: RecentEventLedgerOptions = {}) {
    this.path = options.path ?? join(birdyBeepDataDir(), "recent-events.json");
    this.#windowMs = options.windowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  #read(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(parsed) ? parsed.filter(isLedgerEntry) : [];
    } catch {
      return [];
    }
  }

  #write(entries: LedgerEntry[]): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, this.path);
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
  }

  /**
   * If `identity` was recorded within the window, return true (it's a duplicate —
   * caller should skip). Otherwise record it (pruning expired entries) and return
   * false. Fail-open: any I/O error returns false (allow the send).
   */
  markAndCheck(identity: string): boolean {
    try {
      const now = this.#now();
      const cutoff = now - this.#windowMs;
      const fresh = this.#read().filter((e) => e.ts >= cutoff);
      if (fresh.some((e) => e.id === identity)) return true; // duplicate within window
      fresh.push({ id: identity, ts: now });
      this.#write(fresh);
      return false;
    } catch {
      return false; // fail open — never drop a notification due to a ledger error
    }
  }

  clear(): void {
    try {
      if (existsSync(this.path)) rmSync(this.path, { force: true });
    } catch {
      /* ignore */
    }
  }

  /** Whether the ledger file has secure (0600) perms. True on Windows (ACL-based). */
  isSecure(): boolean {
    if (process.platform === "win32") return true;
    try {
      return (statSync(this.path).mode & 0o077) === 0;
    } catch {
      return true; // absent file → nothing insecure
    }
  }
}
