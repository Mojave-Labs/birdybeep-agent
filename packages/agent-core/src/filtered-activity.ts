/**
 * The locally-filtered-activity tally (birdybeep-agent-gcgp.3) — a small, bounded on-disk
 * record of events the hook pipeline handled WITHOUT sending them, because their type is
 * `local_only` in the notify matrix (see `notify-matrix.ts`).
 *
 * Why record them at all: dropping them silently makes a working install look identical to a
 * dead one. `birdybeep status` / `doctor` answer "are my hooks firing?" — and after gcgp.3 the
 * noisiest proof that they are (Codex `PostToolUse` → `tool_finished`) no longer reaches the
 * backend, so the answer has to come from this machine. Same shape and same reasoning as the
 * unpaired notice (gcgp.4): one fixed-size file, rewritten in place, read back by the next
 * BirdyBeep command.
 *
 * Content is metadata only — counts and two timestamps, keyed by EVENT TYPE (a closed §10.1
 * vocabulary). No titles, no bodies, no paths, no session ids (§15 privacy invariants).
 *
 * NOT a ledger: the read-modify-write is not atomic across concurrent hook processes, so a
 * simultaneous pair can lose an increment. That is the same trade the queue's overflow counter
 * makes — a diagnostic is not worth a lock on the hot path, and the write it replaces was an
 * HTTP POST.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { birdyBeepDataDir } from "./paths";

/** Cap on distinct event types retained, so the file can never grow with input. */
const MAX_TYPES = 16;

export interface FilteredActivity {
  /** How many events were handled locally and never sent. */
  count: number;
  /** Epoch ms of the first one recorded. */
  firstAt: number;
  /** Epoch ms of the most recent one. */
  lastAt: number;
  /** Per-event-type counts, e.g. `{ tool_finished: 1016 }`. Never event content. */
  byType: Record<string, number>;
}

export interface FilteredActivityOptions {
  /** Override the tally path (tests). Default `<dataDir>/filtered-events.json`. */
  path?: string;
  /** Injectable clock (ms since epoch). */
  now?: () => number;
}

/** Where the tally lives: alongside the queue in the user DATA dir, never repo-local. */
export function filteredActivityPath(): string {
  return join(birdyBeepDataDir(), "filtered-events.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read the tally back. `null` when absent, unreadable, or not the shape we wrote. */
export function readFilteredActivity(
  options: FilteredActivityOptions = {},
): FilteredActivity | null {
  const path = options.path ?? filteredActivityPath();
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return null;
    const count = parsed["count"];
    const firstAt = parsed["firstAt"];
    const lastAt = parsed["lastAt"];
    if (typeof count !== "number" || count <= 0) return null;
    if (typeof firstAt !== "number" || typeof lastAt !== "number") return null;
    const byType: Record<string, number> = {};
    if (isRecord(parsed["byType"])) {
      for (const [type, n] of Object.entries(parsed["byType"])) {
        if (typeof n === "number" && n > 0) byType[type] = n;
      }
    }
    return { count, firstAt, lastAt, byType };
  } catch {
    return null; // best-effort: a corrupt tally must never break status/doctor
  }
}

/**
 * Record one event handled locally instead of sent, returning the updated tally (or `null` if
 * it could not be written). Called from the hot path, so: never throws, one small atomic
 * write, no network.
 */
export function recordFilteredEvent(
  eventType: string,
  options: FilteredActivityOptions = {},
): FilteredActivity | null {
  const path = options.path ?? filteredActivityPath();
  const at = (options.now ?? (() => Date.now()))();
  try {
    const previous = readFilteredActivity({ path });
    const byType = { ...(previous?.byType ?? {}) };
    if (
      eventType.length > 0 &&
      (byType[eventType] !== undefined || Object.keys(byType).length < MAX_TYPES)
    ) {
      byType[eventType] = (byType[eventType] ?? 0) + 1;
    }
    const activity: FilteredActivity = {
      count: (previous?.count ?? 0) + 1,
      firstAt: previous?.firstAt ?? at,
      lastAt: at,
      byType,
    };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(activity), { mode: 0o600 });
    renameSync(tmp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    return activity;
  } catch {
    return null;
  }
}

/** Remove the tally. Safe no-op when absent; never throws. */
export function clearFilteredActivity(options: FilteredActivityOptions = {}): void {
  try {
    rmSync(options.path ?? filteredActivityPath(), { force: true });
  } catch {
    /* ignore */
  }
}
