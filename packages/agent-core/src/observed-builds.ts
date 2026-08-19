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
 * WHY THE KEY IS (SURFACE, VERSION) AND NOT VERSION ALONE — this was keyed by version first, and
 * that inverted the feature in two ways, both of which reported a build that had NEVER run the
 * hook as covered:
 *
 *   - Two channels can ship the SAME release. One entry then served the terminal row and the
 *     desktop row alike, so a single terminal event marked a dead desktop build active.
 *   - A surface whose version cannot be read off disk (the ChatGPT-bundled Codex) adopted the one
 *     unclaimed observation. After the terminal CLI upgraded, its RETIRED version became exactly
 *     that — so the desktop build inherited an event fired by a different binary entirely.
 *
 * The surface is the coarsest discriminator that is actually OBSERVABLE at hook time — terminal
 * vs desktop, from what the harness tells its hook child (`CLAUDE_CODE_ENTRYPOINT`, Codex's
 * rollout `originator`). Which of several PATH installs ran is not knowable from a payload, and
 * is not invented here: `unknown` is a real value, and grading treats it as evidence that cannot
 * settle an ambiguity rather than as evidence for whichever row is convenient.
 *
 * This file is LOCAL — never sent, never part of the wire contract — so re-keying it costs no
 * cross-repo lockstep. A tally written by an older CLI is read back as `unknown`-surface entries,
 * which is the honest reading: those events happened, and nothing recorded where.
 *
 * Same shape and same trade as the unpaired notice (gcgp.4) and the filtered tally (gcgp.3): one
 * bounded file in the user data dir, rewritten in place, read back by the next BirdyBeep command.
 * Content is metadata only — a harness id, a surface kind, a version string that already passed
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
/** Cap on distinct builds retained per harness. Least-recently-observed is evicted at the cap. */
export const MAX_OBSERVED_BUILDS = 8;

/**
 * Where an event came from, as far as the harness was willing to say. `unknown` is not a failure
 * — Cursor's payloads carry no such field, and a tally written before this key existed has none
 * either — it means "this event happened and nothing named its surface".
 */
export const OBSERVED_SURFACE_KINDS = ["terminal", "desktop", "unknown"] as const;
export type ObservedSurfaceKind = (typeof OBSERVED_SURFACE_KINDS)[number];

export interface ObservedBuild {
  /** Which kind of surface reported it. */
  surface: ObservedSurfaceKind;
  /** The `harness_version` the harness itself reported (gcgp.7). */
  version: string;
  count: number;
  /** Epoch ms of the first event seen from this build. */
  firstAt: number;
  /** Epoch ms of the most recent one. */
  lastAt: number;
}

export interface HarnessObservation {
  /** Builds seen, keyed by `${surface}:${version}` (a version can never contain `:`). */
  builds: Record<string, ObservedBuild>;
  /**
   * Events from this harness that named no build at all. Codex's `notify` surface has no
   * transcript to read a version out of, and OpenCode reports none yet — those still prove the
   * harness ran our hook, they just cannot be attributed to a row.
   */
  unversioned: number;
}

/** harness id → what has been observed from it. */
export type ObservedBuilds = Record<string, HarnessObservation>;

/** What an adapter can say about the build that just fired. */
export interface BuildIdentity {
  version?: unknown;
  surface?: unknown;
}

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

/** The composite key for one observed build. `:` cannot appear in a sanitized version. */
export function observedBuildKey(surface: ObservedSurfaceKind, version: string): string {
  return `${surface}:${version}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSurfaceKind(value: unknown): ObservedSurfaceKind {
  return OBSERVED_SURFACE_KINDS.includes(value as ObservedSurfaceKind)
    ? (value as ObservedSurfaceKind)
    : "unknown";
}

/** Keep only the {@link MAX_OBSERVED_BUILDS} most recently observed builds. */
function capBuilds(builds: Record<string, ObservedBuild>): Record<string, ObservedBuild> {
  const entries = Object.entries(builds);
  if (entries.length <= MAX_OBSERVED_BUILDS) return builds;
  entries.sort(([, a], [, b]) => b.lastAt - a.lastAt);
  return Object.fromEntries(entries.slice(0, MAX_OBSERVED_BUILDS));
}

function parseObservation(value: unknown): HarnessObservation | null {
  if (!isRecord(value)) return null;
  const builds: Record<string, ObservedBuild> = {};
  if (isRecord(value["builds"])) {
    for (const [key, entry] of Object.entries(value["builds"])) {
      if (!isRecord(entry)) continue;
      const count = entry["count"];
      const firstAt = entry["firstAt"];
      const lastAt = entry["lastAt"];
      if (typeof count !== "number" || count <= 0) continue;
      if (typeof firstAt !== "number" || typeof lastAt !== "number") continue;
      // A tally from before the surface key existed has BARE-VERSION keys and no `surface`
      // field. Read those as `unknown` rather than dropping them: the events did happen, and a
      // CLI upgrade should not erase a machine's coverage history.
      const separator = key.indexOf(":");
      const fromKey = separator < 0 ? key : key.slice(separator + 1);
      const version = sanitizeHarnessVersion(entry["version"] ?? fromKey);
      if (version === undefined) continue;
      const surface = asSurfaceKind(entry["surface"]);
      builds[observedBuildKey(surface, version)] = { surface, version, count, firstAt, lastAt };
    }
  }
  const unversioned = value["unversioned"];
  const observation: HarnessObservation = {
    builds: capBuilds(builds),
    unversioned: typeof unversioned === "number" && unversioned > 0 ? unversioned : 0,
  };
  if (Object.keys(observation.builds).length === 0 && observation.unversioned === 0) return null;
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
 * Record that `harness` fired our hook, from the build `identity` names.
 *
 * Called from the hot path for EVERY mappable payload, whatever the send outcome — delivered,
 * queued, unpaired, filtered or deduped. The question this answers is "did this build reach our
 * hook", exactly like the Codex trust marker's (birdybeep-agent-qyf), and a queued or filtered
 * event proves that just as well as a delivered one. Never throws; one small atomic write.
 */
export function recordObservedBuild(
  harness: string,
  identity: BuildIdentity,
  options: ObservedBuildsOptions = {},
): void {
  const path = options.path ?? observedBuildsPath();
  const at = (options.now ?? (() => Date.now()))();
  try {
    if (harness.length === 0) return;
    const tally = readObservedBuilds({ path });
    const existing = tally[harness];
    if (existing === undefined && Object.keys(tally).length >= MAX_HARNESSES) return;
    const observation: HarnessObservation = existing ?? { builds: {}, unversioned: 0 };

    // Re-sanitize rather than trust the caller: the value originates in harness-controlled input.
    const version = sanitizeHarnessVersion(identity.version);
    if (version === undefined) {
      observation.unversioned += 1;
    } else {
      const surface = asSurfaceKind(identity.surface);
      const key = observedBuildKey(surface, version);
      const previous = observation.builds[key];
      observation.builds[key] = {
        surface,
        version,
        count: (previous?.count ?? 0) + 1,
        firstAt: previous?.firstAt ?? at,
        lastAt: at,
      };
      // Evict the least-recently-observed build rather than refusing new ones. Discarding
      // FUTURE versions was worse than it sounds: grading matches only recorded builds, so once
      // eight historical versions accumulated, the build the user is actually running today
      // could never become `active` and read as a coverage gap while firing continuously.
      observation.builds = capBuilds(observation.builds);
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
