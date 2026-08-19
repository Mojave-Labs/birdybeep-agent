/**
 * The one-step setup chain (birdybeep-agent-gcgp.5): everything `birdybeep setup` (and
 * `birdybeep pair`) does once a machine token exists — detect every supported harness, install
 * the ones that are present, and print a per-BUILD coverage table, then send a real test Beep.
 *
 * Pairing on its own wired nothing up. `pair` ended at "Run `birdybeep test`", the test Beep
 * arrived, and the machine looked finished with zero harnesses installed. So the chain lives
 * here and both verbs run it.
 *
 * Everything that can still stop a beep is a ROW in the table or a line under one, never
 * swallowed: Codex's one-time `/hooks` trust (and, after gcgp.15, the migration that turns
 * turn-complete off until it is granted), OpenCode's restart, a `notify` slot another tool owns,
 * a build that has never fired, an install that threw, a harness that is not installed at all.
 *
 * Adapters / sender / token store / observed-build tally are injectable, so the whole chain runs
 * hermetically against real adapters under a temp HOME.
 */
import {
  type AgentAdapter,
  type HarnessSurfaceKind,
  type InstallResult,
  type IntegrationStatus,
  type Sender,
  type TokenStoreOptions,
} from "@birdybeep/agent-core";
import { claudeCodeAdapter } from "@birdybeep/claude-code";
import { codexAdapter } from "@birdybeep/codex";
import { copilotAdapter } from "@birdybeep/copilot";
import { cursorAdapter } from "@birdybeep/cursor";
import { opencodeAdapter } from "@birdybeep/opencode";

import {
  describeSurface,
  gatherSurfaces,
  type HarnessSurfaces,
  type SurfaceCoverageOptions,
  surfaceRemedy,
  type SurfaceState,
} from "../diagnostics";
import { type GlobalFlags, type Io } from "../framework";
import { installTarget } from "./agent";
import { createTestCommand } from "./test";

export const SETUP_ADAPTERS: readonly AgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
  cursorAdapter,
  copilotAdapter,
];

/**
 * What a row of the coverage table says about one build.
 *
 * `ready` and `beeping` are both wired; they differ in whether anything has come through yet, and
 * on a fresh machine every row is `ready`. The other four each have a different fix, which is why
 * they are not collapsed into one "broken".
 */
export type SetupState =
  /** Events from this build have already reached BirdyBeep. */
  | "beeping"
  /** Wired up; it beeps on the next turn. */
  | "ready"
  /** Installed, but a one-time user action (Codex `/hooks`, an OpenCode restart) is pending. */
  | "needs you"
  /** Installed for other builds, but this one cannot beep — see its remedy. */
  | "not covered"
  /** The harness is not on this machine. */
  | "not installed"
  /** Detection or install threw. */
  | "failed";

/** One line of the coverage table: a single build of a single harness. */
export interface SetupRow {
  harness: string;
  displayName: string;
  /** The build, e.g. "terminal CLI 2.1.227". Absent when the harness is not installed. */
  build?: string;
  kind?: HarnessSurfaceKind;
  state: SetupState;
  /** A fix that applies to THIS build only (gcgp.6's per-surface remedy). */
  remedy?: string;
}

/** Everything the chain did to one harness, plus the rows it produced. */
export interface SetupHarnessReport {
  harness: string;
  displayName: string;
  detected: boolean;
  status?: IntegrationStatus;
  changedFiles?: string[];
  backupFiles?: string[];
  /** What the user must still do for this harness, in the adapter's own words. */
  actions: string[];
  /** Present when detect() or install() threw — the run continues, the row says `failed`. */
  error?: string;
  rows: SetupRow[];
}

export interface SetupReport {
  harnesses: SetupHarnessReport[];
  counts: { installed: number; needsYou: number; notInstalled: number; failed: number };
  /** The `birdybeep test` result, when the chain sent one. */
  beep?: unknown;
  /** False when a harness install failed or the test Beep was rejected. */
  ok: boolean;
}

export interface SetupDeps {
  /** Adapter set (tests inject deterministic detection). Defaults to every supported harness. */
  adapters?: AgentAdapter[];
  tokenOptions?: TokenStoreOptions;
  /** Build the sender for the closing test Beep (tests inject a stub). */
  createSender?: (baseUrl: string) => Sender;
  /** Where the observed-builds tally lives (tests point it at a sandbox). */
  surfaceOptions?: SurfaceCoverageOptions;
}

export interface SetupOptions {
  /** Send the closing test Beep through the real sender path (`--no-test` turns it off). */
  sendTest: boolean;
}

/** Statuses that mean a one-time user action stands between the install and the first beep. */
const PENDING_STATUSES: ReadonlySet<IntegrationStatus> = new Set<IntegrationStatus>([
  "needs_trust",
  "needs_restart",
]);

interface HarnessInstall {
  adapter: AgentAdapter;
  detected: boolean;
  result?: InstallResult;
  error?: string;
}

/**
 * Detect every adapter and install the ones that are there. An adapter that throws is recorded
 * and the loop continues: one broken harness must not cost the user the other four, and the
 * failure has to reach the table rather than the exit code alone.
 */
async function installDetected(adapters: readonly AgentAdapter[]): Promise<HarnessInstall[]> {
  const installs: HarnessInstall[] = [];
  for (const adapter of adapters) {
    try {
      const detection = await adapter.detect();
      if (!detection.detected) {
        installs.push({ adapter, detected: false });
        continue;
      }
      installs.push({ adapter, detected: true, result: await adapter.install() });
    } catch (err) {
      installs.push({
        adapter,
        detected: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return installs;
}

/** The state of one build, given what its harness's install did and what gcgp.6 graded it. */
function rowState(
  state: SurfaceState,
  group: HarnessSurfaces,
  status: IntegrationStatus | undefined,
): SetupState {
  if (status === "error" || group.status === "error") return "failed";
  if (status !== undefined && PENDING_STATUSES.has(status)) return "needs you";
  if (state.coverage === "active") return "beeping";
  if (state.coverage === "wired") return "ready";
  // `uncovered` right after a successful install means this build specifically has never fired
  // while a sibling of the same harness is delivering — gcgp.6 grades that, and owns the fix.
  return "not covered";
}

/** Turn the installs plus gcgp.6's surface grading into the table's rows. */
export function buildHarnessReports(
  installs: HarnessInstall[],
  groups: HarnessSurfaces[],
): SetupHarnessReport[] {
  return installs.map((install) => {
    const { adapter } = install;
    const base = {
      harness: adapter.id,
      displayName: adapter.displayName,
      detected: install.detected,
      ...(install.result !== undefined
        ? {
            status: install.result.status,
            changedFiles: install.result.changedFiles,
            backupFiles: install.result.backupFiles,
          }
        : {}),
      ...(install.error !== undefined ? { error: install.error } : {}),
    };

    if (install.error !== undefined) {
      return {
        ...base,
        actions: [
          `${adapter.displayName} could not be set up: ${install.error}`,
          `Run \`birdybeep agent install ${installTarget(adapter.id)}\` to retry it on its own.`,
        ],
        rows: [{ harness: adapter.id, displayName: adapter.displayName, state: "failed" as const }],
      };
    }

    if (!install.detected) {
      return {
        ...base,
        actions: [],
        rows: [
          {
            harness: adapter.id,
            displayName: adapter.displayName,
            state: "not installed" as const,
          },
        ],
      };
    }

    const group = groups.find((g) => g.harness === adapter.id);
    const status = install.result?.status;
    const surfaces = group?.surfaces ?? [];
    // No surface list means the adapter does not enumerate builds (or its probe failed). The
    // harness still gets one row — silently dropping it would read as "not supported".
    const rows: SetupRow[] =
      group === undefined || surfaces.length === 0
        ? [
            {
              harness: adapter.id,
              displayName: adapter.displayName,
              state:
                status !== undefined && PENDING_STATUSES.has(status)
                  ? ("needs you" as const)
                  : ("ready" as const),
            },
          ]
        : surfaces.map((state) => {
            const graded = rowState(state, group, status);
            // gcgp.6 returns no per-surface remedy when the harness-level status is the cause —
            // it expects `doctor`'s own harness check to carry the fix, and setup prints no such
            // check, so the row would otherwise say "not covered" and stop there.
            const remedy =
              surfaceRemedy(state, group) ??
              (graded === "not covered"
                ? `${adapter.displayName} carries no BirdyBeep hooks — re-run \`birdybeep agent install ${installTarget(adapter.id)}\` from a shell where \`birdybeep\` resolves.`
                : undefined);
            return {
              harness: adapter.id,
              displayName: adapter.displayName,
              build: describeSurface(state),
              kind: state.surface.kind,
              state: graded,
              ...(remedy !== undefined ? { remedy } : {}),
            };
          });

    return { ...base, actions: [...(install.result?.requiredActions ?? [])], rows };
  });
}

/** Pad to `width`, never truncating — a long build name pushes its row out rather than losing it. */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

const MARKS: Record<SetupState, string> = {
  beeping: "✓",
  ready: "✓",
  "needs you": "!",
  "not covered": "✗",
  "not installed": "–",
  failed: "✗",
};

/** The coverage table: one row per installed build, and one per harness that is not installed. */
export function renderCoverageTable(reports: SetupHarnessReport[]): string[] {
  const rows = reports.flatMap((r) => r.rows);
  const nameWidth = Math.max(7, ...rows.map((r) => r.displayName.length));
  const buildWidth = Math.max(5, ...rows.map((r) => (r.build ?? "—").length));

  const lines = ["coverage", `   ${pad("harness", nameWidth)}  ${pad("build", buildWidth)}  state`];
  for (const report of reports) {
    for (const row of report.rows) {
      lines.push(
        `${MARKS[row.state]}  ${pad(row.displayName, nameWidth)}  ${pad(row.build ?? "—", buildWidth)}  ${row.state}`,
      );
      if (row.remedy !== undefined) lines.push(`     → ${row.remedy}`);
    }
    for (const action of report.actions) lines.push(`     → ${action}`);
  }
  return lines;
}

/**
 * What to tell someone about the harnesses that are not here. A machine with none of them is the
 * dead end this ticket exists to close: the run must say what to install and that re-running
 * finishes the job, not just print five skips.
 */
export function describeMissing(reports: SetupHarnessReport[]): string[] {
  const missing = reports.filter((r) => !r.detected && r.error === undefined);
  if (missing.length === 0) return [];
  const names = missing.map((r) => r.displayName);
  if (missing.length === reports.length) {
    return [
      "No supported coding agent is installed on this machine, so there was nothing to wire up.",
      `Install one of ${names.join(", ")}, then run \`birdybeep setup\` again — pairing is already done, so it picks up from here.`,
    ];
  }
  return [
    `Not installed: ${names.join(", ")}. Install any of them, then run \`birdybeep setup\` again to wire it up.`,
  ];
}

/**
 * Run the post-pairing half of setup: install every detected harness, print the coverage table,
 * and (unless turned off) send a real test Beep through the production sender path.
 *
 * Prints nothing under `--json` — the caller folds the returned report into its own result object
 * so the stream stays one terminal line per command.
 */
export async function runHarnessSetup(
  ctx: { io: Io; flags: GlobalFlags },
  options: SetupOptions,
  deps: SetupDeps = {},
): Promise<SetupReport> {
  const adapters = deps.adapters ?? [...SETUP_ADAPTERS];
  const installs = await installDetected(adapters);
  // Graded AFTER the install, so `status` reflects the config we just wrote.
  const groups = await gatherSurfaces(adapters, deps.surfaceOptions ?? {});
  const reports = buildHarnessReports(installs, groups);

  ctx.io.line("");
  for (const line of renderCoverageTable(reports)) ctx.io.line(line);
  const missing = describeMissing(reports);
  if (missing.length > 0) {
    ctx.io.line("");
    for (const line of missing) ctx.io.line(line);
  }

  const counts = {
    installed: reports.filter((r) => r.detected && r.error === undefined).length,
    needsYou: reports.filter((r) => r.rows.some((row) => row.state === "needs you")).length,
    notInstalled: reports.filter((r) => !r.detected && r.error === undefined).length,
    // A row that graded `failed` counts too: an adapter that returned status "error" never threw,
    // so counting only thrown errors would report a clean run over a harness that is broken.
    failed: reports.filter((r) => r.error !== undefined || r.rows.some((x) => x.state === "failed"))
      .length,
  };

  let beep: unknown;
  let beepOk = true;
  if (options.sendTest) {
    ctx.io.line("");
    // The REAL `test` command, so the closing Beep exercises exactly the path a hook does.
    // Its `--json` result is captured rather than printed: setup emits one object, not two.
    const command = createTestCommand({
      ...(deps.createSender !== undefined ? { createSender: deps.createSender } : {}),
      ...(deps.tokenOptions !== undefined ? { tokenOptions: deps.tokenOptions } : {}),
    });
    const beepIo: Io = {
      ...ctx.io,
      result: (value: unknown) => {
        beep = value;
      },
    };
    beepOk = (await command.run?.({ args: [], flags: ctx.flags, io: beepIo })) === 0;
  }

  return {
    harnesses: reports,
    counts,
    ...(beep !== undefined ? { beep } : {}),
    ok: counts.failed === 0 && beepOk,
  };
}
