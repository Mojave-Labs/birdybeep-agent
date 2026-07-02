/**
 * Recent-event dedup ledger. Each harness hook fires in its OWN process (no daemon),
 * and a single user action can trigger more than one hook (e.g. Claude Code may emit
 * both PermissionRequest and Notification{permission_prompt} for one approval). To
 * avoid a double-beep, the ledger records recently-delivered event identities on disk
 * (strict perms, in the user data dir) and collapses a repeat of the same identity
 * within a short window. Best-effort + FAIL-OPEN: if the ledger can't be read/written
 * it allows the send (better a rare double-beep than a dropped notification).
 *
 * Identity is CONTENT-AWARE (birdybeep-agent-erm): it includes a hash of title+body,
 * so two DIFFERENT notifications of the same type inside the window both beep (the old
 * type-only identity silently dropped the second one). The one case that must still
 * collapse across DIFFERENT content — Claude Code's permission double-fire, whose two
 * shapes share a type but not a body — is handled by the separate short
 * {@link approvalCollapseIdentity} window checked by the hook pipeline.
 */
import { createHash } from "node:crypto";
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

/**
 * Window for collapsing the SAME-approval double-fire (same session + type, different
 * body — e.g. "Claude Code needs your permission…" vs "Approve Bash?"). DELIBERATE
 * TRADEOFF: within this window a genuinely DISTINCT second approval is also collapsed
 * (dropped!), inverting the module's better-double-beep-than-drop bias — so the window
 * is as short as the double-fire allows. The double-fire is one harness action emitting
 * two hooks back-to-back (typically <100ms apart); two REAL approvals are separated by
 * the human answering the first, or by prompts that Claude Code serializes in its UI —
 * sub-second spacing is not a realistic distinct-approval pattern. Keep this ≤ the
 * ledger's default window (markAndCheck clamps a wider value down) and NEVER raise it
 * casually: every added millisecond widens the drop window for real approvals.
 * Best-effort under concurrency: two SIMULTANEOUS hook processes can both pass the
 * read-check-write ledger race and double-beep — that direction is fail-open (annoying,
 * not lossy) and accepted.
 */
export const APPROVAL_COLLAPSE_WINDOW_MS = 1_000;

export interface RecentEventLedgerOptions {
  /** Ledger file path (default `<dataDir>/recent-events.json`). */
  path?: string;
  /** Dedup window in ms (default 10s). Also the retention horizon for pruning. */
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

/** Short content digest for the identity — a hash, never the content itself (§15.2). */
function contentHash(title: string, body: string): string {
  return createHash("sha256").update(`${title}\n${body}`).digest("hex").slice(0, 16);
}

/**
 * A canonical identity for an event: same harness + session + type + CONTENT = the
 * "same beep". Content rides as a truncated hash so the ledger file never stores
 * notification text (§15.2).
 */
export function eventIdentity(event: {
  harness: string;
  source_session_id: string;
  event_type: string;
  title: string;
  body: string;
}): string {
  return `${event.harness}:${event.source_session_id}:${event.event_type}:${contentHash(
    event.title,
    event.body,
  )}`;
}

/**
 * The content-BLIND identity used ONLY for the approval double-fire collapse (see the
 * module doc): one physical approval emits two payload shapes whose bodies differ, so
 * the content-aware identity cannot pair them.
 */
export function approvalCollapseIdentity(event: {
  harness: string;
  source_session_id: string;
}): string {
  return `${event.harness}:${event.source_session_id}:approval_required:any`;
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
   * false. `windowMs` narrows the duplicate check for THIS identity (e.g. the short
   * approval-collapse window) — pruning always uses the ledger's own (max) window so
   * a narrower check never evicts entries other checks still need. Fail-open: any
   * I/O error returns false (allow the send).
   */
  markAndCheck(identity: string, windowMs: number = this.#windowMs): boolean {
    try {
      const now = this.#now();
      const pruneCutoff = now - this.#windowMs;
      const dupCutoff = now - Math.min(windowMs, this.#windowMs);
      const fresh = this.#read().filter((e) => e.ts >= pruneCutoff);
      if (fresh.some((e) => e.id === identity && e.ts >= dupCutoff)) return true; // duplicate
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
