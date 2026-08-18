/**
 * Local retry queue (§9.3, §15.3). When delivery fails or the machine is offline,
 * a normalized event is parked on disk and drained opportunistically on the next
 * hook/CLI invocation — there is NO background daemon. The queue is best-effort
 * (≤24h retention, not a durable audit log), strict-permissioned (dir 0700, files
 * 0600), lives OUTSIDE the repo, and must never throw into or block the harness.
 *
 * This module owns enqueue/drain/clear primitives; the HTTP POST + timeout logic
 * lives in CORE-SENDER, which drives `drain` with a send callback.
 */
import { randomUUID } from "node:crypto";
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

import type { BirdyBeepAgentEvent } from "./event";
import { birdyBeepDataDir } from "./paths";

/** 24h default retention (§15.3). */
export const QUEUE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Default max entries drained per call so a drain never blocks the harness (§9.3). */
export const DEFAULT_DRAIN_MAX = 50;
/**
 * Hard cap on how many entries the queue holds (birdybeep-agent-gcgp.4). Age was the ONLY
 * bound, so a machine that could not deliver grew one file per hook fire until the 24h window
 * caught up — observed in the field at 1138 files / 4.5 MB, and every one of them would have
 * been POSTed the moment delivery started working. 500 is ~10x a heavy day's real backlog and
 * still drains inside the sender's 50-per-call budget in a handful of invocations.
 */
export const DEFAULT_QUEUE_MAX_ENTRIES = 500;
/**
 * Running total of entries the cap has dropped, kept next to the entries it counts (a
 * non-`.json` name, so every read path skips it). Read-modify-write, not atomic across
 * concurrent hooks: it is a diagnostic counter for `status`/`doctor`, never a ledger, and a
 * lost increment is worth less than the locking it would take to prevent.
 */
const OVERFLOW_COUNTER_FILE = "overflow.count";
/** Leading `<enqueuedAt>-` of every name this queue writes (`.json`, `.tmp` and `.claim` alike). */
const ENQUEUED_AT_PREFIX = /^(\d+)-/;
/**
 * Age after which a `.claim` file is considered ORPHANED and returned to the queue
 * (erm): a drain claims an entry via rename before sending; if that process is killed
 * mid-send the claim would otherwise strand the event forever (claims are invisible
 * to normal reads). Far above any legitimate in-flight send (bounded to seconds).
 */
export const CLAIM_RECLAIM_MS = 60_000;

/** What the sender decided for one queued event. delivered/drop → remove; retry → keep. */
export type DrainOutcome = "delivered" | "drop" | "retry";

export interface DrainResult {
  delivered: number;
  dropped: number;
  kept: number;
  pruned: number;
}

interface QueueEntry {
  path: string;
  enqueuedAt: number;
  event: BirdyBeepAgentEvent;
}

export interface LocalEventQueueOptions {
  /** Queue directory (default `<dataDir>/queue`). Tests pass a sandbox path. */
  dir?: string;
  /** Retention window in ms (default 24h). */
  retentionMs?: number;
  /** Max entries retained (default {@link DEFAULT_QUEUE_MAX_ENTRIES}); oldest are dropped first. */
  maxEntries?: number;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Best-effort on-disk queue. Every public method swallows I/O errors (returning a
 * safe default) so a full/locked/corrupt queue degrades gracefully and never
 * throws into the calling hook.
 */
export class LocalEventQueue {
  readonly dir: string;
  readonly #retentionMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: LocalEventQueueOptions = {}) {
    this.dir = options.dir ?? join(birdyBeepDataDir(), "queue");
    this.#retentionMs = options.retentionMs ?? QUEUE_RETENTION_MS;
    this.#maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_QUEUE_MAX_ENTRIES);
    this.#now = options.now ?? (() => Date.now());
  }

  /** Ensure the dir exists with 0700 perms; repair a too-permissive existing dir. */
  #ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.dir, 0o700); // repair perms
  }

  /** Park a normalized event on disk (atomic write, 0600). Never throws. */
  enqueue(event: BirdyBeepAgentEvent): boolean {
    try {
      this.#ensureDir();
      const enqueuedAt = this.#now();
      const name = `${enqueuedAt}-${randomUUID()}.json`;
      const finalPath = join(this.dir, name);
      const tmpPath = `${finalPath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify({ enqueuedAt, event }), { mode: 0o600 });
      renameSync(tmpPath, finalPath);
      if (process.platform !== "win32") chmodSync(finalPath, 0o600);
      // Cap AFTER the write, so the newest event is never the one refused (gcgp.4). One readdir
      // over a set the cap itself bounds; no file is opened, since the enqueue time is in the name.
      this.#enforceCap();
      return true;
    } catch {
      return false; // best-effort: a failed enqueue must never break the harness
    }
  }

  /** The `<enqueuedAt>` encoded in a queue filename; 0 (i.e. ancient) when unparseable. */
  #enqueuedAtOf(name: string): number {
    const at = Number(ENQUEUED_AT_PREFIX.exec(name)?.[1]);
    return Number.isFinite(at) ? at : 0;
  }

  /**
   * Drop the OLDEST entries until at most `maxEntries` remain, recording how many were lost.
   * Oldest-first because a backlog's value decays: "your agent needs you" from twenty minutes
   * ago still matters, the same line from yesterday does not. Never throws.
   */
  #enforceCap(): number {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    const entries = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ name, at: this.#enqueuedAtOf(name) }));
    const excess = entries.length - this.#maxEntries;
    if (excess <= 0) return 0;
    entries.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    let dropped = 0;
    for (const entry of entries.slice(0, excess)) {
      try {
        rmSync(join(this.dir, entry.name), { force: true });
        dropped += 1;
      } catch {
        /* another process got there first — never throw */
      }
    }
    if (dropped > 0) this.#recordOverflowDrops(dropped);
    return dropped;
  }

  /** How many entries the count cap has dropped on this machine. 0 when never exceeded. */
  overflowDropCount(): number {
    try {
      const raw = readFileSync(join(this.dir, OVERFLOW_COUNTER_FILE), "utf8").trim();
      const value = Number.parseInt(raw, 10);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0; // absent/corrupt → nothing has been dropped as far as anyone can tell
    }
  }

  #recordOverflowDrops(count: number): void {
    try {
      const path = join(this.dir, OVERFLOW_COUNTER_FILE);
      writeFileSync(path, `${this.overflowDropCount() + count}\n`, { mode: 0o600 });
      if (process.platform !== "win32") chmodSync(path, 0o600);
    } catch {
      /* the counter is a diagnostic; losing it must never break a hook */
    }
  }

  /**
   * Discard every entry enqueued before `cutoffMs`, returning how many events were dropped.
   *
   * The cold-start guard (gcgp.4): `pair` calls this the moment a token is stored, so a first
   * pairing does not replay the backlog the machine accumulated while it had nowhere to send.
   * A user pairing for the first time wants the NEXT beep, not eighteen hours of retroactive
   * ones — and the backend's storm summariser turns that replay into real pushes even for
   * event types that would never beep on their own.
   *
   * In-flight `.claim`s and half-written `.tmp`s from before the cutoff go too (they carry the
   * same `<enqueuedAt>-` prefix): a claim orphaned by a dead drainer would otherwise rejoin the
   * queue later and deliver exactly the event this guard exists to discard. Never throws.
   *
   * The cutoff is INCLUSIVE (gcgp.24): an entry stamped exactly `cutoffMs` is discarded. Entry
   * timestamps are milliseconds, so an event enqueued in the same millisecond as pairing is
   * genuinely ambiguous — it could have been written a hair before or a hair after the token
   * landed. Resolving that toward "discard" makes the guard deterministic and fails safe toward
   * the storm it exists to prevent; keeping it made the outcome depend on sub-millisecond timing
   * (a same-millisecond entry survived 133 of 200 probe runs, and flaked the pre-push gate at
   * ~1 run in 5). Losing one event at the instant of pairing costs nothing — the user has just
   * paired, and the next event delivers.
   */
  discardBefore(cutoffMs: number): number {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    let discarded = 0;
    for (const name of names) {
      if (!ENQUEUED_AT_PREFIX.test(name)) continue; // e.g. the overflow counter — not an entry
      if (this.#enqueuedAtOf(name) > cutoffMs) continue;
      try {
        rmSync(join(this.dir, name), { force: true });
        if (name.endsWith(".json")) discarded += 1; // .tmp/.claim aren't deliverable events
      } catch {
        /* ignore */
      }
    }
    return discarded;
  }

  /**
   * Return orphaned `.claim` files (claims older than {@link CLAIM_RECLAIM_MS}) to the
   * queue by renaming them back to their original `.json` name. The claim timestamp is
   * embedded in the claim FILENAME (rename preserves mtime, so fs times would report
   * the enqueue age, not the claim age — an active drain of an old entry must not be
   * "reclaimed" out from under it). Racing reclaims are safe: rename losers ENOENT.
   * Known window: a drainer SUSPENDED (not dead) >60s can resume after its claim was
   * reclaimed and double-send — accepted, since 60s ≫ the 5s send budget (a claim that
   * old almost always is a dead process) and the backend dedupe absorbs the repeat.
   */
  #reclaimOrphanedClaims(names: string[]): void {
    const cutoff = this.#now() - CLAIM_RECLAIM_MS;
    for (const name of names) {
      const m = /^(.+\.json)\.(\d+)-[0-9a-f-]+\.claim$/.exec(name);
      if (!m || Number(m[2]) > cutoff) continue; // not a claim, or still legitimately in flight
      try {
        renameSync(join(this.dir, name), join(this.dir, m[1]!)); // back into the queue
      } catch {
        /* another process won the reclaim (or the fs refused) — never throw */
      }
    }
  }

  /** Read all non-expired entries (FIFO by enqueue time); prune expired/corrupt ones. */
  #readFresh(): { fresh: QueueEntry[]; pruned: number } {
    if (!existsSync(this.dir)) return { fresh: [], pruned: 0 };
    if (process.platform !== "win32") {
      try {
        chmodSync(this.dir, 0o700); // repair a too-permissive dir on any access
      } catch {
        /* ignore */
      }
    }
    let pruned = 0;
    const fresh: QueueEntry[] = [];
    const cutoff = this.#now() - this.#retentionMs;
    let names: string[];
    try {
      names = readdirSync(this.dir);
      this.#reclaimOrphanedClaims(names); // orphaned claims rejoin the queue first (erm)
      names = readdirSync(this.dir); // re-list so reclaimed entries are visible this pass
    } catch {
      return { fresh: [], pruned: 0 };
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue; // skip .tmp / .claim
      const path = join(this.dir, name);
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        const enqueuedAt = isRecord(parsed) ? parsed["enqueuedAt"] : undefined;
        const event = isRecord(parsed) ? parsed["event"] : undefined;
        if (typeof enqueuedAt !== "number" || !isRecord(event)) {
          rmSync(path, { force: true }); // corrupt → drop
          pruned++;
          continue;
        }
        if (enqueuedAt < cutoff) {
          rmSync(path, { force: true }); // expired → prune, never deliver
          pruned++;
          continue;
        }
        fresh.push({ path, enqueuedAt, event: event as unknown as BirdyBeepAgentEvent });
      } catch {
        try {
          rmSync(path, { force: true });
        } catch {
          /* ignore */
        }
        pruned++;
      }
    }
    fresh.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    return { fresh, pruned };
  }

  /** Count of fresh (non-expired) queued events. Prunes expired entries as a side effect. */
  size(): number {
    return this.#readFresh().fresh.length;
  }

  /**
   * Apply retention AND the count cap WITHOUT sending anything, reporting what was dropped
   * and what remains (`kept` is the on-disk depth after the pass; nothing is delivered).
   *
   * Exists for the no-token path (87n): that path can never drain, and pruning lives only
   * inside {@link #readFresh} — reachable via drain/size alone. So an unpaired machine grew
   * one file per hook fire forever and the documented 24h retention was silently defeated
   * (observed in the field: 457 entries, the oldest two weeks past the window). The cap runs
   * here too (gcgp.4) so a backlog left by an older CLI is trimmed on the first fire after an
   * upgrade rather than waiting out the retention window. Never throws.
   */
  prune(): DrainResult {
    const result: DrainResult = { delivered: 0, dropped: 0, kept: 0, pruned: 0 };
    try {
      const read = this.#readFresh();
      result.kept = Math.max(0, read.fresh.length - this.#enforceCap());
      result.pruned = read.pruned;
    } catch {
      /* best-effort, like every other method here — never throw into the hook */
    }
    return result;
  }

  /**
   * Drain up to `max` fresh entries through `send`. Each entry is CLAIMED via an
   * atomic rename before sending, so two concurrent drains never double-send the
   * same event. delivered/drop remove the entry; retry keeps it for next time.
   * Bounded + best-effort: never throws into the caller.
   */
  async drain(
    send: (event: BirdyBeepAgentEvent) => Promise<DrainOutcome> | DrainOutcome,
    options: { max?: number; stopWhen?: () => boolean } = {},
  ): Promise<DrainResult> {
    const max = options.max ?? DEFAULT_DRAIN_MAX;
    const result: DrainResult = { delivered: 0, dropped: 0, kept: 0, pruned: 0 };
    let fresh: QueueEntry[];
    try {
      this.#ensureDir();
      const read = this.#readFresh();
      fresh = read.fresh;
      result.pruned = read.pruned;
    } catch {
      return result;
    }
    for (const entry of fresh.slice(0, max)) {
      // Budget bound (erm): the sender stops the drain when the hook's total time
      // budget is spent — unclaimed entries simply stay queued for the next drain.
      if (options.stopWhen?.() === true) {
        result.kept += 1;
        continue;
      }
      const claim = `${entry.path}.${this.#now()}-${randomUUID()}.claim`;
      try {
        renameSync(entry.path, claim); // atomic claim; loser gets ENOENT → skip
      } catch {
        continue; // another drain already owns this entry
      }
      let outcome: DrainOutcome;
      try {
        outcome = await send(entry.event);
      } catch {
        outcome = "retry"; // sender threw → keep for next drain
      }
      if (outcome === "retry") {
        try {
          renameSync(claim, entry.path); // release the claim
        } catch {
          /* ignore */
        }
        result.kept++;
      } else {
        try {
          rmSync(claim, { force: true });
        } catch {
          /* ignore */
        }
        if (outcome === "delivered") result.delivered++;
        else result.dropped++;
      }
    }
    return result;
  }

  /** Remove every queued entry (used by `doctor` / debug tooling). Never throws. */
  clear(): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    try {
      for (const name of readdirSync(this.dir)) {
        try {
          rmSync(join(this.dir, name), { force: true });
          if (name !== OVERFLOW_COUNTER_FILE) removed++; // the counter is not a queued event
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return removed;
  }

  /** Whether the queue dir has secure (0700) perms. Returns true on Windows (ACL-based). */
  isSecure(): boolean {
    if (process.platform === "win32") return true;
    try {
      return (statSync(this.dir).mode & 0o077) === 0;
    } catch {
      return false;
    }
  }
}
