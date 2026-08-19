/**
 * The observed-builds tally (birdybeep-agent-gcgp.6) — which BUILD of each harness has actually
 * run BirdyBeep's hook command on this machine.
 *
 * Config presence cannot answer that. Every surface of a harness shares one config file: the
 * terminal Claude Code CLI and the engine the Claude desktop app manages both read
 * `~/.claude/settings.json`; the npm Codex and the one bundled in ChatGPT.app share one
 * `~/.codex/config.toml`. So "installed" is a single fact about a whole harness, and it says
 * nothing about whether the desktop app ever reached the hook. This file is what says that.
 *
 * The key is `harness_version` (birdybeep-agent-gcgp.7), which every adapter fills from what the
 * harness hands the hook — an env var it exported, or the transcript it just wrote — never a
 * `--version` probe. That is the only value that names the build which FIRED, rather than the
 * build that happens to be first on PATH.
 *
 * Same shape and same trade as the unpaired notice (gcgp.4) and the filtered tally (gcgp.3): one
 * fixed-size file in the user data dir, rewritten in place, read back by the next BirdyBeep
 * command. Content is metadata only — a harness id, a version string that already passed
 * `sanitizeHarnessVersion`, counts and timestamps. No titles, no bodies, no paths, no session ids
 * (§15).
 *
 * NOT a ledger: the read-modify-write is not atomic across concurrent hook processes, so a
 * simultaneous pair can lose an increment. A diagnostic is not worth a lock on the hot path.
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

import { sanitizeHarnessVersion } from "./harness-version";
import { birdyBeepDataDir } from "./paths";

/** Cap on harnesses retained (five exist; the cap is for a corrupted or hostile file). */
const MAX_HARNESSES = 8;
/** Cap on distinct builds retained per harness, so the file can never grow with input. */
const MAX_BUILDS = 8;

export interface ObservedBuild {
  count: number;
  /** Epoch ms of the first event seen from this build. */
  firstAt: number;
  /** Epoch ms of the most recent one. */
  lastAt: number;
}

export interface HarnessObservation {
  /** Builds seen, keyed by the `harness_version` the harness itself reported. */
  builds: Record<string, ObservedBuild>;
  /**
   * Events from this harness that named no build at all. Codex's `notify` surface has no
   * transcript to read a version out of, and OpenCode reports none yet — those still prove the
   * harness ran our hook, they just cannot be attributed to a surface.
   */
  unversioned: number;
}

/** harness id → what has been observed from it. */
export type ObservedBuilds = Record<string, HarnessObservation>;

export interface ObservedBuildsOptions {
  /** Override the tally path (tests). Default `<dataDir>/observed-builds.json`. */
  path?: string;
  /** Injectable clock (ms since epoch). */
  now?: () => number;
}

/** Where the tally lives: alongside the queue in the user DATA dir, never repo-local. */
export function observedBuildsPath(): string {
  return join(birdyBeepDataDir(), "observed-builds.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObservation(value: unknown): HarnessObservation | null {
  if (!isRecord(value)) return null;
  const builds: Record<string, ObservedBuild> = {};
  if (isRecord(value["builds"])) {
    for (const [version, entry] of Object.entries(value["builds"])) {
      if (Object.keys(builds).length >= MAX_BUILDS) break;
      if (sanitizeHarnessVersion(version) !== version || !isRecord(entry)) continue;
      const count = entry["count"];
      const firstAt = entry["firstAt"];
      const lastAt = entry["lastAt"];
      if (typeof count !== "number" || count <= 0) continue;
      if (typeof firstAt !== "number" || typeof lastAt !== "number") continue;
      builds[version] = { count, firstAt, lastAt };
    }
  }
  const unversioned = value["unversioned"];
  const observation: HarnessObservation = {
    builds,
    unversioned: typeof unversioned === "number" && unversioned > 0 ? unversioned : 0,
  };
  if (Object.keys(builds).length === 0 && observation.unversioned === 0) return null;
  return observation;
}

/** Read the tally back. `{}` when absent, unreadable, or not the shape we wrote. */
export function readObservedBuilds(options: ObservedBuildsOptions = {}): ObservedBuilds {
  const path = options.path ?? observedBuildsPath();
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return {};
    const result: ObservedBuilds = {};
    for (const [harness, value] of Object.entries(parsed)) {
      if (Object.keys(result).length >= MAX_HARNESSES) break;
      const observation = parseObservation(value);
      if (observation !== null) result[harness] = observation;
    }
    return result;
  } catch {
    return {}; // best-effort: a corrupt tally must never break status/doctor
  }
}

/**
 * Record that `harness` fired our hook, from build `version` when it said which.
 *
 * Called from the hot path for EVERY mappable payload, whatever the send outcome — delivered,
 * queued, unpaired, filtered or deduped. The question this answers is "did this build reach our
 * hook", exactly like the Codex trust marker's (birdybeep-agent-qyf), and a queued or filtered
 * event proves that just as well as a delivered one. Never throws; one small atomic write.
 */
export function recordObservedBuild(
  harness: string,
  version: unknown,
  options: ObservedBuildsOptions = {},
): void {
  const path = options.path ?? observedBuildsPath();
  const at = (options.now ?? (() => Date.now()))();
  try {
    if (harness.length === 0) return;
    const tally = readObservedBuilds({ path });
    const existing = tally[harness];
    const observation: HarnessObservation = existing ?? { builds: {}, unversioned: 0 };
    if (existing === undefined && Object.keys(tally).length >= MAX_HARNESSES) return;
    // Re-sanitize rather than trust the caller: the value originates in harness-controlled input.
    const build = sanitizeHarnessVersion(version);
    if (build === undefined) {
      observation.unversioned += 1;
    } else {
      const previous = observation.builds[build];
      if (previous === undefined && Object.keys(observation.builds).length >= MAX_BUILDS) {
        observation.unversioned += 1; // still proof the harness ran; just not a new build slot
      } else {
        observation.builds[build] = {
          count: (previous?.count ?? 0) + 1,
          firstAt: previous?.firstAt ?? at,
          lastAt: at,
        };
      }
    }
    tally[harness] = observation;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(tally), { mode: 0o600 });
    renameSync(tmp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch {
    /* a diagnostic tally must never break, slow, or throw into the harness */
  }
}

/** Remove the tally. Safe no-op when absent; never throws. */
export function clearObservedBuilds(options: ObservedBuildsOptions = {}): void {
  try {
    rmSync(options.path ?? observedBuildsPath(), { force: true });
  } catch {
    /* ignore */
  }
}
