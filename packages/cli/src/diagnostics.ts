/**
 * Shared status/queue plumbing used by `birdybeep status` and `birdybeep doctor`: gather
 * each adapter's integration status, the machine identity + pairing state, and local queue
 * depth. Read-only + privacy-safe — never prints token material or notification bodies.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import {
  type AgentAdapter,
  type DetectionResult,
  type FilteredActivity,
  getMachineIdentity,
  getToken,
  type HarnessObservation,
  type HarnessSurface,
  type IntegrationStatus,
  LocalEventQueue,
  type ObservedBuildsOptions,
  readFilteredActivity,
  readObservedBuilds,
  readToken,
  readUnpairedNotice,
  type TokenStoreKind,
  type TokenStoreOptions,
  type UnpairedNotice,
} from "@birdybeep/agent-core";
import {
  BIRDYBEEP_HOOK_EVENTS as CLAUDE_HOOK_EVENTS,
  claudeSettingsPath,
  isBirdyBeepEntry as isClaudeEntry,
} from "@birdybeep/claude-code";
import {
  BIRDYBEEP_HOOK_EVENTS as CURSOR_HOOK_EVENTS,
  cursorHooksPath,
  detectCursor,
  isBirdyBeepEntry as isCursorEntry,
} from "@birdybeep/cursor";

export interface IntegrationState {
  harness: string;
  displayName: string;
  status: IntegrationStatus;
}

/** Each adapter's current §8.8 integration status (runs the real adapter.status()). */
export async function gatherIntegrations(adapters: AgentAdapter[]): Promise<IntegrationState[]> {
  return Promise.all(
    adapters.map(async (a) => ({
      harness: a.id,
      displayName: a.displayName,
      status: await a.status(),
    })),
  );
}

/** Is a machine token present in the secure store? (pairing state — never prints the token.) */
export async function isPaired(tokenOptions: TokenStoreOptions = {}): Promise<boolean> {
  return (await getToken(tokenOptions)) !== null;
}

/**
 * The three answers `status` and `doctor` can give about pairing (birdybeep-agent-gcgp.23).
 * `unknown` is not a shade of `unpaired`: the store failed, so this machine may well BE paired,
 * and telling that user "not paired" is a wrong diagnosis rather than a vague one.
 */
export type PairingState = "paired" | "unpaired" | "unknown";

export interface PairingReport {
  state: PairingState;
  /** Why the store could not answer. Set only when `state` is `unknown`; never token material. */
  reason?: string;
  /** Which store could not answer. Set only when `state` is `unknown`; picks the remedy. */
  store?: TokenStoreKind;
}

/** Read the pairing state, distinguishing "no token" from "the token store would not answer". */
export async function pairingReport(tokenOptions: TokenStoreOptions = {}): Promise<PairingReport> {
  const lookup = await readToken(tokenOptions);
  if (lookup.state === "present") return { state: "paired" };
  if (lookup.state === "absent") return { state: "unpaired" };
  return { state: "unknown", reason: lookup.reason, store: lookup.store };
}

/**
 * One line for a token store that will not answer. It carries the three facts the "not paired"
 * line cannot: this says nothing about whether you are paired, events are being QUEUED rather
 * than lost, and it resolves as soon as the store is readable.
 */
export function describeTokenStoreUnavailable(report: PairingReport): string {
  return (
    `Could not read the token store (${report.reason ?? "unknown error"}), so whether this ` +
    "machine is paired is unknown. Events fired now are QUEUED, not lost, and send once it " +
    "is readable."
  );
}

/**
 * What to do about a token store that will not answer — which depends on WHICH store it was.
 * The keychain case is a lock to open. The file case (Linux, Windows, headless) is a path or a
 * permission to repair: unlocking nothing helps, and `birdybeep pair` writes the same bad path,
 * so telling the user to run it again is advice that cannot work.
 */
export function tokenStoreRemedy(report: PairingReport): string {
  if (report.store === "file") {
    return (
      "Repair the token file — check that its directory and the file itself are readable and " +
      "writable by you (`chmod 700` the directory, `chmod 600` the file), then run " +
      "`birdybeep doctor` again to drain the queue."
    );
  }
  return (
    "Unlock your login keychain (log in to the desktop session, or unlock the screen), then " +
    "run `birdybeep doctor` again to drain the queue. If it stays unreadable, run " +
    "`birdybeep pair`."
  );
}

/** Current local event-queue depth (fresh, non-expired entries). */
export function localQueueDepth(): number {
  return new LocalEventQueue().size();
}

/** How many events the queue's count cap has dropped on this machine (gcgp.4). */
export function localQueueOverflowDrops(): number {
  return new LocalEventQueue().overflowDropCount();
}

/**
 * Events that fired while this machine had no token, and were therefore never sent (gcgp.4).
 * `null` once the machine is paired — `pair` clears the notice.
 */
export function unpairedActivity(): UnpairedNotice | null {
  return readUnpairedNotice();
}

/** One line describing an unpaired-activity notice, for `status` / `doctor`. */
export function describeUnpairedActivity(notice: UnpairedNotice): string {
  const since = new Date(notice.firstAt).toISOString();
  const from = notice.harnesses.length > 0 ? ` from ${notice.harnesses.join(", ")}` : "";
  return `${notice.count} event(s)${from} fired since ${since} and were NOT sent — this machine is not paired.`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * How many of `events` carry a BirdyBeep-managed entry in a harness hooks config.
 * A missing file is 0; a file that cannot be parsed is `null` — a corrupt config is a
 * different failure, with its own check, and says nothing about what is installed.
 */
function birdyBeepHookCount(
  path: string,
  events: readonly string[],
  isBirdyBeepEntry: (entry: unknown) => boolean,
): number | null {
  if (!existsSync(path)) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const hooks = asRecord(asRecord(parsed)["hooks"]);
  let present = 0;
  for (const event of events) {
    const entries = hooks[event];
    if (Array.isArray(entries) && entries.some(isBirdyBeepEntry)) present += 1;
  }
  return present;
}

export interface CursorBridgeOptions {
  /** Override the home dir (default `os.homedir()`, which honors `$HOME`). */
  home?: string;
  /** Injectable Cursor detection for tests (avoids shelling out to `cursor-agent --version`). */
  detect?: () => Promise<DetectionResult>;
}

/**
 * Is Cursor reaching BirdyBeep ONLY through its Claude Code compatibility bridge (gcgp.13)?
 * True when Cursor is present, our Claude hooks are installed (the bridge reads
 * `~/.claude/settings.json` and runs them), and `~/.cursor/hooks.json` carries none of ours.
 * That machine gets lifecycle events attributed to Cursor but no approvals — the bridge drops
 * `Notification` and `PermissionRequest`. Read-only; cross-adapter, so it belongs to neither
 * adapter's own doctor(). False once the Cursor adapter is installed.
 */
export async function cursorBridgeOnly(opts: CursorBridgeOptions = {}): Promise<boolean> {
  const home = opts.home ?? homedir();
  const detection = await (opts.detect ?? (() => detectCursor({ home })))();
  if (!detection.detected) return false;
  const claude = birdyBeepHookCount(claudeSettingsPath(home), CLAUDE_HOOK_EVENTS, isClaudeEntry);
  if (claude === null || claude === 0) return false;
  return birdyBeepHookCount(cursorHooksPath(home), CURSOR_HOOK_EVENTS, isCursorEntry) === 0;
}

/**
 * Events the hook pipeline handled locally and never sent, because the backend can never
 * push their type (gcgp.3). `null` when nothing has been filtered on this machine.
 */
export function filteredActivity(): FilteredActivity | null {
  return readFilteredActivity();
}

/**
 * One line describing locally-filtered activity, for `status` / `doctor`. This is the
 * "your hooks ARE firing" evidence — after gcgp.3 the highest-volume proof of a working
 * install (Codex `PostToolUse`) never reaches the backend, so it has to be reported here.
 */
export function describeFilteredActivity(activity: FilteredActivity): string {
  const types = Object.entries(activity.byType)
    .sort(([, a], [, b]) => b - a)
    .map(([type, n]) => `${type} ×${n}`)
    .join(", ");
  const since = new Date(activity.firstAt).toISOString();
  return `${activity.count} local-only event(s) since ${since}${types ? ` (${types})` : ""}. Hooks are firing; these types never produce notifications, so they are not sent.`;
}

/** Machine label + OS (the event `machine` identity). */
export function machineIdentity(): { label: string; os: string } {
  return getMachineIdentity();
}

/**
 * Per-SURFACE coverage (birdybeep-agent-gcgp.6).
 *
 *   active    — this build has fired BirdyBeep's hook.
 *   wired     — the harness config carries our entries, but nothing has come from this build yet.
 *   uncovered — this build cannot beep: either the harness has no BirdyBeep entries at all, or it
 *               has them and every OTHER build of the same harness is delivering while this one
 *               never has.
 */
export type SurfaceCoverage = "active" | "wired" | "uncovered";

export interface SurfaceState {
  surface: HarnessSurface;
  coverage: SurfaceCoverage;
  /** Events observed from this build. */
  events: number;
  /** Epoch ms of the most recent one. */
  lastAt?: number;
  /**
   * The build this surface was seen running as, when the filesystem could not say. Set only for
   * a surface whose `version` is unknown and which an observed build could be attributed to.
   */
  observedVersion?: string;
}

export interface HarnessSurfaces {
  harness: string;
  displayName: string;
  /** The harness's own §8.8 status — one fact about the shared config, for every surface. */
  status: IntegrationStatus;
  surfaces: SurfaceState[];
  /** Events from this harness that named no build, so they belong to no row. */
  unversionedEvents: number;
}

/** Statuses that mean BirdyBeep's entries ARE in the harness config (trust/restart still pending). */
const CONFIGURED_STATUSES: ReadonlySet<IntegrationStatus> = new Set<IntegrationStatus>([
  "installed",
  "needs_trust",
  "needs_restart",
]);

/**
 * Attribute observed builds to surfaces and grade each one.
 *
 * Matching is by (SURFACE KIND, VERSION), never version alone. Two release channels can ship the
 * same version, and a version the terminal CLI has since upgraded away from is not evidence about
 * a desktop build — keying on version alone made both of those report a build that had never run
 * the hook as covered.
 *
 * Three ways a surface can be matched, in descending order of certainty:
 *   1. exact — an observation of this surface's kind AND version;
 *   2. sole-of-kind — a surface whose version cannot be read off disk (the ChatGPT-bundled Codex)
 *      claims an unclaimed observation OF ITS OWN KIND, and only when that is unambiguous;
 *   3. unattributed — an observation whose surface the harness never named (Cursor says nothing;
 *      so does a tally written before this key existed). It counts as evidence only when exactly
 *      one surface carries its version. When two do, it settles nothing, and it SUPPRESSES the
 *      uncovered verdict for them rather than picking a row — under-claiming is the safe
 *      direction, the same call the Codex trust marker makes.
 */
function gradeSurfaces(
  surfaces: HarnessSurface[],
  status: IntegrationStatus,
  observation: HarnessObservation | undefined,
): SurfaceState[] {
  const builds = Object.values(observation?.builds ?? {});
  const configured = CONFIGURED_STATUSES.has(status);

  const claimedByKind = new Map<string, Set<string>>();
  for (const s of surfaces) {
    if (s.version === undefined) continue;
    const versions = claimedByKind.get(s.kind) ?? new Set<string>();
    versions.add(s.version);
    claimedByKind.set(s.kind, versions);
  }

  const graded = surfaces.map((surface) => {
    const exact = builds.filter(
      (b) =>
        b.surface === surface.kind &&
        b.version === surface.version &&
        surface.version !== undefined,
    );

    // (2) sole-of-kind, scoped to this surface's own kind so a terminal build's retired version
    // can never be adopted by a desktop row.
    let soleOfKind: typeof builds = [];
    if (surface.version === undefined) {
      const sameKindVersionless = surfaces.filter(
        (s) => s.version === undefined && s.kind === surface.kind,
      );
      const unclaimed = builds.filter(
        (b) =>
          b.surface === surface.kind && !(claimedByKind.get(surface.kind)?.has(b.version) ?? false),
      );
      if (unclaimed.length === 1 && sameKindVersionless.length === 1) soleOfKind = unclaimed;
    }

    // (3) unattributed observations that carry this surface's version.
    const unattributed =
      surface.version === undefined
        ? []
        : builds.filter((b) => b.surface === "unknown" && b.version === surface.version);
    const sharesVersion =
      surface.version !== undefined &&
      surfaces.some((s) => s !== surface && s.version === surface.version);
    const ambiguous = unattributed.length > 0 && sharesVersion;

    const matched = [...exact, ...soleOfKind, ...(ambiguous ? [] : unattributed)];
    const events = matched.reduce((total, b) => total + b.count, 0);
    const lastAt = matched.reduce<number | undefined>(
      (latest, b) => (latest === undefined || b.lastAt > latest ? b.lastAt : latest),
      undefined,
    );
    const observedVersion = surface.version === undefined ? soleOfKind[0]?.version : undefined;

    return {
      surface,
      events,
      ambiguous,
      ...(lastAt !== undefined ? { lastAt } : {}),
      ...(observedVersion !== undefined ? { observedVersion } : {}),
    };
  });

  // "Uncovered" needs a comparison, not an absolute: on a machine where nothing has fired yet,
  // every build is equally unproven and none of them is a fault. It becomes a real, actionable
  // gap only once a SIBLING build of the same harness is delivering and this one still is not.
  //
  // A SHADOWED install is exempt from that comparison in both directions: it sits behind another
  // one on PATH, so it is expected never to fire, and calling that a fault would tell the user to
  // go fix a build they cannot even run.
  const anyActive = graded.some((g) => g.events > 0 && g.surface.shadowed !== true);
  return graded.map(({ ambiguous, ...g }) => ({
    ...g,
    coverage: !configured
      ? ("uncovered" as const)
      : g.events > 0
        ? ("active" as const)
        : anyActive && g.surface.shadowed !== true && !ambiguous
          ? ("uncovered" as const)
          : ("wired" as const),
  }));
}

export interface SurfaceCoverageOptions {
  /** Override the observed-builds tally path (tests). */
  observedBuilds?: ObservedBuildsOptions;
}

/**
 * Every harness's installed builds, graded. Runs the real `adapter.detect()` (which enumerates
 * surfaces) and `adapter.status()`, and reads the local observed-builds tally — no network, no
 * spawning of any engine beyond the `--version` probe detection already does.
 */
export async function gatherSurfaces(
  adapters: AgentAdapter[],
  options: SurfaceCoverageOptions = {},
): Promise<HarnessSurfaces[]> {
  const observed = readObservedBuilds(options.observedBuilds ?? {});
  return Promise.all(
    adapters.map(async (adapter) => {
      const observation = observed[adapter.id];
      const base = {
        harness: adapter.id,
        displayName: adapter.displayName,
        unversionedEvents: observation?.unversioned ?? 0,
      };
      try {
        const [detection, status] = await Promise.all([adapter.detect(), adapter.status()]);
        return {
          ...base,
          status,
          surfaces: detection.detected
            ? gradeSurfaces(detection.surfaces ?? [], status, observation)
            : [],
        };
      } catch {
        // Coverage reporting is a diagnostic: an adapter that cannot probe itself must degrade
        // to "no rows", never take down the `doctor` run that was supposed to explain it.
        return { ...base, status: "unknown" as IntegrationStatus, surfaces: [] };
      }
    }),
  );
}

/** How a surface row is titled in `status` / `doctor`: label plus the build it is. */
export function describeSurface(state: SurfaceState): string {
  const version = state.surface.version ?? state.observedVersion;
  return version !== undefined ? `${state.surface.label} ${version}` : state.surface.label;
}

/**
 * One line saying what is (or is not) reaching this surface, and why. The two ways a surface ends
 * up uncovered have different answers, so they read differently: the harness has no BirdyBeep
 * entries at all, or it has them and every sibling build is delivering while this one never has.
 */
export function describeSurfaceCoverage(state: SurfaceState, group: HarnessSurfaces): string {
  if (state.coverage === "active") {
    const last = state.lastAt !== undefined ? `, last ${new Date(state.lastAt).toISOString()}` : "";
    return `covered: ${state.events} event(s) from this build${last}`;
  }
  if (state.coverage === "wired") {
    return state.surface.shadowed === true
      ? `${group.displayName}'s hooks are installed and this build shares them, but another install comes first on PATH. This build runs only if that order changes.`
      : `${group.displayName}'s hooks are installed and this build shares them; nothing has fired from it yet`;
  }
  if (!CONFIGURED_STATUSES.has(group.status)) {
    return `not covered: ${group.displayName} carries no BirdyBeep hooks, so this build cannot produce notifications`;
  }
  const active = group.surfaces.filter((s) => s.coverage === "active").map(describeSurface);
  const delivering = active.join(", ");
  const verb = active.length === 1 ? "is" : "are";
  return `not covered: nothing has fired from this build, while ${delivering} ${verb} delivering through the same config`;
}

/** CLI install target for an adapter id (the CLI says `claude`, the adapter id is `claude_code`). */
function installTarget(harness: string): string {
  return harness === "claude_code" ? "claude" : harness;
}

/** What to do about an uncovered surface; `undefined` when another check already owns the fix. */
export function surfaceRemedy(state: SurfaceState, group: HarnessSurfaces): string | undefined {
  if (state.coverage !== "uncovered") return undefined;
  // The harness-level cause already has its own check with its own remedy — don't print it twice.
  if (!CONFIGURED_STATUSES.has(group.status)) return undefined;
  const install = `\`birdybeep agent install ${installTarget(group.harness)}\``;
  // The two kinds fail for different reasons, so they get different instructions. A desktop app
  // spawns its engine with the LOGIN shell's PATH, which is where a bare hook command goes
  // missing — the failure this whole epic turned up.
  return state.surface.kind === "desktop"
    ? `Run a turn in ${state.surface.label}. If it stays uncovered, that build cannot run the hook ` +
        `command: a desktop app spawns its engine with your LOGIN shell's PATH, not an interactive ` +
        `shell's, so a bare command is invisible to it. Re-run ${install} from a shell where ` +
        `\`birdybeep\` resolves. This rewrites the entry with absolute paths that do not depend on PATH.`
    : `Run a turn in ${state.surface.label}. If it stays uncovered, re-run ${install} from a shell ` +
        `where \`birdybeep\` resolves, then check that ${state.surface.enginePath} is the build you ` +
        `are actually running.`;
}
