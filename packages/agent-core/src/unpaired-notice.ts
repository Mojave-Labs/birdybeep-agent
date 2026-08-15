/**
 * The unpaired-activity notice (birdybeep-agent-gcgp.4) — a small, bounded on-disk record that
 * harness hooks FIRED on this machine while it had no machine token, so their events went
 * nowhere. `status` and `doctor` read it back and say so.
 *
 * Why a file rather than only a message: the hot path cannot talk to anyone. An installed hook
 * command is bare — no `--json`, no terminal, nobody watching — so `io.line` writes nothing and
 * a stderr line reaches a harness log the user has no reason to open. Something has to survive
 * the process and be waiting the next time they run a BirdyBeep command, which is exactly when
 * they are asking "why haven't I got any beeps?". One file, fixed size, rewritten in place.
 *
 * Deliberately NOT an OS notification: the hot path may not spawn (it has a hard time budget and
 * a harness kills whatever overruns it), `osascript`/`notify-send`/PowerShell are three more
 * platform paths to get wrong, and a tool that pops a system alert for its own misconfiguration
 * is worse than the silence it replaces.
 *
 * Content is metadata only — a count, two timestamps, and the harness ids involved. No titles,
 * no bodies, no paths (§15 privacy invariants).
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

/** Cap on distinct harness ids retained, so the file can never grow with input. */
const MAX_HARNESSES = 16;

export interface UnpairedNotice {
  /** How many events were discarded because this machine is not paired. */
  count: number;
  /** Epoch ms of the first discarded event in this run of unpaired-ness. */
  firstAt: number;
  /** Epoch ms of the most recent one. */
  lastAt: number;
  /** Harness ids that fired (e.g. `claude_code`), sorted; never event content. */
  harnesses: string[];
}

export interface UnpairedNoticeOptions {
  /** Override the notice path (tests). Default `<dataDir>/unpaired-events.json`. */
  path?: string;
  /** Injectable clock (ms since epoch). */
  now?: () => number;
}

/** Where the notice lives: alongside the queue in the user DATA dir, never repo-local. */
export function unpairedNoticePath(): string {
  return join(birdyBeepDataDir(), "unpaired-events.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read the notice back. `null` when absent, unreadable, or not the shape we wrote. */
export function readUnpairedNotice(options: UnpairedNoticeOptions = {}): UnpairedNotice | null {
  const path = options.path ?? unpairedNoticePath();
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return null;
    const count = parsed["count"];
    const firstAt = parsed["firstAt"];
    const lastAt = parsed["lastAt"];
    if (typeof count !== "number" || count <= 0) return null;
    if (typeof firstAt !== "number" || typeof lastAt !== "number") return null;
    const harnesses = Array.isArray(parsed["harnesses"])
      ? parsed["harnesses"].filter((h): h is string => typeof h === "string")
      : [];
    return { count, firstAt, lastAt, harnesses };
  } catch {
    return null; // best-effort: a corrupt notice must never break status/doctor
  }
}

/**
 * Record one event that was discarded for want of a machine token, returning the updated
 * notice (or `null` if it could not be written). Called from the hot path, so: never throws,
 * one small atomic write, and no network.
 */
export function recordUnpairedEvent(
  harness: string,
  options: UnpairedNoticeOptions = {},
): UnpairedNotice | null {
  const path = options.path ?? unpairedNoticePath();
  const at = (options.now ?? (() => Date.now()))();
  try {
    const previous = readUnpairedNotice({ path });
    const harnesses = new Set(previous?.harnesses ?? []);
    if (harness.length > 0 && harnesses.size < MAX_HARNESSES) harnesses.add(harness);
    const notice: UnpairedNotice = {
      count: (previous?.count ?? 0) + 1,
      firstAt: previous?.firstAt ?? at,
      lastAt: at,
      harnesses: [...harnesses].sort(),
    };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(notice), { mode: 0o600 });
    renameSync(tmp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    return notice;
  } catch {
    return null;
  }
}

/** Remove the notice (the machine is paired now). Safe no-op when absent; never throws. */
export function clearUnpairedNotice(options: UnpairedNoticeOptions = {}): void {
  try {
    rmSync(options.path ?? unpairedNoticePath(), { force: true });
  } catch {
    /* ignore */
  }
}
