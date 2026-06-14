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
  readonly #now: () => number;

  constructor(options: LocalEventQueueOptions = {}) {
    this.dir = options.dir ?? join(birdyBeepDataDir(), "queue");
    this.#retentionMs = options.retentionMs ?? QUEUE_RETENTION_MS;
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
      return true;
    } catch {
      return false; // best-effort: a failed enqueue must never break the harness
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
   * Drain up to `max` fresh entries through `send`. Each entry is CLAIMED via an
   * atomic rename before sending, so two concurrent drains never double-send the
   * same event. delivered/drop remove the entry; retry keeps it for next time.
   * Bounded + best-effort: never throws into the caller.
   */
  async drain(
    send: (event: BirdyBeepAgentEvent) => Promise<DrainOutcome> | DrainOutcome,
    options: { max?: number } = {},
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
      const claim = `${entry.path}.${randomUUID()}.claim`;
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
          removed++;
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
