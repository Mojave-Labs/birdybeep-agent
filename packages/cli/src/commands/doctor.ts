/**
 * `birdybeep doctor` (§9.4, §21.1–21.2) — the self-service troubleshooter. Runs a battery
 * of checks (machine token, each adapter's doctor() incl. needs_trust/needs_restart/error,
 * local queue health, backend reachability), prints a concrete copy-pasteable fix for each
 * failure, drains the queue opportunistically, and exits non-zero when anything fails so
 * it's CI/script friendly. Read-only (never mutates harness config); never prints token
 * material or notification bodies. `--json` mirrors all findings.
 */
import {
  type AgentAdapter,
  createSender as defaultCreateSender,
  DEFAULT_QUEUE_MAX_ENTRIES as QUEUE_CAP,
  type DetectionResult,
  type Sender,
  type TokenStoreOptions,
} from "@birdybeep/agent-core";
import { claudeCodeAdapter } from "@birdybeep/claude-code";
import { codexAdapter } from "@birdybeep/codex";
import { copilotAdapter } from "@birdybeep/copilot";
import { cursorAdapter } from "@birdybeep/cursor";
import { opencodeAdapter } from "@birdybeep/opencode";

import { resolveApiUrl } from "../config";
import {
  cursorBridgeOnly,
  describeFilteredActivity,
  describeSurface,
  describeSurfaceCoverage,
  describeTokenStoreUnavailable,
  describeUnpairedActivity,
  filteredActivity,
  gatherSurfaces,
  localQueueDepth,
  localQueueOverflowDrops,
  pairingReport,
  type SurfaceCoverageOptions,
  surfaceRemedy,
  tokenStoreRemedy,
  unpairedActivity,
} from "../diagnostics";
import { type Command, EXIT } from "../framework";

const DEFAULT_ADAPTERS: AgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
  cursorAdapter,
  copilotAdapter,
];

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  remedy?: string;
}

/** Best-effort backend reachability probe (HEAD; any non-5xx response = reachable). */
async function defaultProbeNetwork(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    if (typeof timer.unref === "function") timer.unref();
    const res = await fetch(baseUrl, { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);
    return res.status < 500;
  } catch {
    return false;
  }
}

export interface DoctorCommandDeps {
  adapters?: AgentAdapter[];
  createSender?: (baseUrl: string) => Sender;
  tokenOptions?: TokenStoreOptions;
  /** Backend reachability probe (tests inject reachable/unreachable). */
  probeNetwork?: (baseUrl: string) => Promise<boolean>;
  /** Cursor detection for the bridge check (tests avoid shelling out to `cursor-agent`). */
  detectCursor?: () => Promise<DetectionResult>;
  /** Where the observed-builds tally lives (tests point it at a sandbox). */
  surfaceOptions?: SurfaceCoverageOptions;
}

export function createDoctorCommand(deps: DoctorCommandDeps = {}): Command {
  const adapters = deps.adapters ?? DEFAULT_ADAPTERS;
  const probeNetwork = deps.probeNetwork ?? defaultProbeNetwork;
  const makeSender =
    deps.createSender ??
    ((baseUrl) =>
      defaultCreateSender(
        deps.tokenOptions ? { baseUrl, tokenOptions: deps.tokenOptions } : { baseUrl },
      ));

  return {
    name: "doctor",
    summary: "Diagnose token, trust, restart, and offline-queue issues",
    usage: "birdybeep doctor [--json]",
    run: async (ctx) => {
      const checks: Check[] = [];
      const apiUrl = resolveApiUrl();

      // 1. Machine token. Three answers, not two (birdybeep-agent-gcgp.23): a store that could
      // not be READ is not a missing token, and "Run `birdybeep pair`" is the wrong instruction
      // for a paired user whose keychain is merely locked — pairing again would not fix it.
      const pairing = await pairingReport(deps.tokenOptions ?? {});
      checks.push(
        pairing.state === "paired"
          ? { name: "Machine token", ok: true }
          : pairing.state === "unpaired"
            ? {
                name: "Machine token",
                ok: false,
                detail: "No machine token found.",
                remedy: "Run `birdybeep pair` to pair this machine.",
              }
            : {
                name: "Machine token",
                ok: false,
                detail: describeTokenStoreUnavailable(pairing),
                remedy: tokenStoreRemedy(pairing),
              },
      );

      // 1b. Events that fired while unpaired and were therefore never sent (gcgp.4). Placed
      // second on purpose: it is the answer to "why am I getting no beeps?", and it has to be
      // visible above the per-adapter checks rather than buried under twenty lines of them.
      const unpaired = unpairedActivity();
      if (unpaired !== null) {
        checks.push({
          name: "Events lost while unpaired",
          ok: false,
          detail: describeUnpairedActivity(unpaired),
          remedy:
            "Run `birdybeep pair`. Events that fired before pairing are gone — a first pairing " +
            "does not replay them.",
        });
      }

      // 1c. Cursor runs BirdyBeep through its Claude Code compatibility bridge, which drops
      // Notification and PermissionRequest (gcgp.13) — so a Cursor user with only the Claude
      // hooks installed sees Cursor events arrive but never an approval. It reads two adapters'
      // config at once, so it can live in neither adapter's doctor(); it sits with the other
      // "why am I missing beeps?" answers, above the per-adapter checks. Silent once the Cursor
      // adapter is installed — nothing to nag about then.
      if (await cursorBridgeOnly(deps.detectCursor ? { detect: deps.detectCursor } : {})) {
        checks.push({
          name: "Approval beeps from Cursor",
          ok: false,
          detail:
            "Cursor is running your agent through the Claude Code hooks — that is why Cursor " +
            "events arrive without a Cursor install. Its bridge drops Notification and " +
            "PermissionRequest, so approvals never reach you.",
          remedy:
            "Run `birdybeep agent install cursor` to get approval beeps from Cursor's own shell " +
            "and MCP permission prompts. Keeping both installed is safe — duplicate events are " +
            "collapsed.",
        });
      }

      // 1d. Hooks that fired and were deliberately NOT sent (gcgp.3). An `ok` check, not a
      // failure: it is the positive evidence that the harness is wired up, which the backend
      // can no longer supply for these types because they never reach it.
      const filtered = filteredActivity();
      if (filtered !== null) {
        checks.push({
          name: "Local-only events (never notifiable)",
          ok: true,
          detail: describeFilteredActivity(filtered),
        });
      }

      // 2. Each adapter's own diagnostics (detected? installed? needs_trust/needs_restart/error?),
      // then 2b: one row per installed BUILD of that harness (gcgp.6). The adapter checks above
      // describe the shared config — one answer for the whole harness — and a machine runs a
      // harness from more than one place: the terminal CLI and the engine a desktop app spawns
      // are separate installs on separate update channels. Kept immediately under their own
      // harness so nothing above is reordered and the two read as one block.
      const surfaceGroups = await gatherSurfaces(adapters, deps.surfaceOptions ?? {});
      for (const adapter of adapters) {
        const result = await adapter.doctor();
        for (const c of result.checks) {
          checks.push({
            name: `${adapter.displayName}: ${c.name}`,
            ok: c.ok,
            ...(c.detail !== undefined ? { detail: c.detail } : {}),
            ...(c.remedy !== undefined ? { remedy: c.remedy } : {}),
          });
        }
        const group = surfaceGroups.find((g) => g.harness === adapter.id);
        if (group === undefined) continue;
        for (const state of group.surfaces) {
          const remedy = surfaceRemedy(state, group);
          checks.push({
            name: `${adapter.displayName}: ${describeSurface(state)}`,
            ok: state.coverage !== "uncovered",
            detail: describeSurfaceCoverage(state, group),
            ...(remedy !== undefined ? { remedy } : {}),
          });
        }
      }

      // 3. Local queue: drain opportunistically, report depth (and any cap overflow, gcgp.4).
      const depthBefore = localQueueDepth();
      const drain = await makeSender(apiUrl).drainNow();
      const depthAfter = localQueueDepth();
      const overflowDropped = localQueueOverflowDrops();
      checks.push({
        name: "Local queue",
        ok: true,
        detail:
          `${depthBefore} queued → ${drain.delivered} delivered, ${depthAfter} remaining` +
          (overflowDropped > 0 ? `; ${overflowDropped} dropped by the ${QUEUE_CAP} entry cap` : ""),
      });

      // 4. Backend reachability.
      const reachable = await probeNetwork(apiUrl);
      checks.push(
        reachable
          ? { name: "Backend reachable", ok: true }
          : {
              name: "Backend reachable",
              ok: false,
              detail: `Could not reach ${apiUrl}.`,
              remedy: "Check your network; queued events will retry automatically.",
            },
      );

      const ok = checks.every((c) => c.ok);

      if (ctx.flags.json) {
        ctx.io.result({
          ok,
          checks,
          pairing, // gcgp.23: paired | unpaired | unknown — never a bare boolean
          surfaces: surfaceGroups,
          queue: { depthBefore, delivered: drain.delivered, depthAfter, overflowDropped },
          ...(unpaired !== null ? { unpairedActivity: unpaired } : {}),
          ...(filtered !== null ? { filteredActivity: filtered } : {}),
        });
      } else {
        for (const c of checks) {
          ctx.io.line(`${c.ok ? "✓" : "✗"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
          if (!c.ok && c.remedy) ctx.io.line(`     → ${c.remedy}`);
        }
        ctx.io.line(ok ? "\nAll checks passed." : "\nSome checks failed — see fixes above.");
      }
      return ok ? EXIT.OK : EXIT.ERROR;
    },
  };
}
