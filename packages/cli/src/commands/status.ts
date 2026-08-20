/**
 * `birdybeep status` (§9.3, §9.4) — a quick health snapshot: machine identity + pairing
 * state, per-harness integration status, and local queue depth, while opportunistically
 * draining the queue (best-effort, non-blocking) and reporting delivered-vs-remaining.
 * Exits non-zero when not paired so scripts can branch. `--json` mirrors everything.
 * Factory with injectable adapters/sender/token so tests run hermetically against a stub.
 */
import {
  type AgentAdapter,
  createSender as defaultCreateSender,
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
  describeFilteredActivity,
  describeSurface,
  describeTokenStoreUnavailable,
  describeUnpairedActivity,
  filteredActivity,
  gatherIntegrations,
  gatherSurfaces,
  localQueueDepth,
  localQueueOverflowDrops,
  machineIdentity,
  pairingReport,
  type SurfaceCoverageOptions,
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

export interface StatusCommandDeps {
  adapters?: AgentAdapter[];
  /** Build the drain sender (default: agent-core createSender at the resolved API URL). */
  createSender?: (baseUrl: string) => Sender;
  /** Token-store options (tests inject the file fallback). */
  tokenOptions?: TokenStoreOptions;
  /** Where the observed-builds tally lives (tests point it at a sandbox). */
  surfaceOptions?: SurfaceCoverageOptions;
}

export function createStatusCommand(deps: StatusCommandDeps = {}): Command {
  const adapters = deps.adapters ?? DEFAULT_ADAPTERS;
  const makeSender =
    deps.createSender ??
    ((baseUrl) =>
      defaultCreateSender(
        deps.tokenOptions ? { baseUrl, tokenOptions: deps.tokenOptions } : { baseUrl },
      ));

  return {
    name: "status",
    summary: "Show pairing + per-harness integration status",
    usage: "birdybeep status [--json]",
    run: async (ctx) => {
      const machine = machineIdentity();
      // gcgp.23: three answers. A token store that would not answer is reported as unknown —
      // "no" would be a wrong diagnosis for the common case (a locked keychain on a machine
      // that IS paired), and the events it affects are queued rather than lost.
      const pairing = await pairingReport(deps.tokenOptions ?? {});
      const paired = pairing.state === "paired";
      const integrations = await gatherIntegrations(adapters);
      // gcgp.6: which BUILD of each harness is actually delivering. `integrations` above answers
      // for the shared config; a machine runs a harness from a terminal CLI and from a desktop
      // app's own engine, and only one of them may ever reach the hook.
      const surfaces = await gatherSurfaces(adapters, deps.surfaceOptions ?? {});
      const depthBefore = localQueueDepth();
      const unpaired = unpairedActivity(); // gcgp.4: events that fired with no token to send them
      const filtered = filteredActivity(); // gcgp.3: events handled locally, never sent
      const drain = await makeSender(resolveApiUrl()).drainNow(); // opportunistic, best-effort
      const depthAfter = localQueueDepth();
      const overflowDropped = localQueueOverflowDrops();

      const report = {
        machine,
        paired,
        pairing, // gcgp.23: paired | unpaired | unknown — `paired: false` cannot say which
        integrations,
        surfaces,
        queue: { depthBefore, delivered: drain.delivered, depthAfter, overflowDropped },
        ...(unpaired !== null ? { unpairedActivity: unpaired } : {}),
        ...(filtered !== null ? { filteredActivity: filtered } : {}),
      };

      if (ctx.flags.json) {
        ctx.io.result(report);
      } else {
        ctx.io.line(`Machine: ${machine.label} (${machine.os})`);
        ctx.io.line(
          pairing.state === "paired"
            ? "Paired:  yes"
            : pairing.state === "unpaired"
              ? "Paired:  no — run `birdybeep pair`"
              : `Paired:  unknown — ${describeTokenStoreUnavailable(pairing)}`,
        );
        ctx.io.line("Integrations:");
        for (const i of integrations) {
          ctx.io.line(`  ${i.displayName}: ${i.status}`);
          const group = surfaces.find((g) => g.harness === i.harness);
          for (const state of group?.surfaces ?? []) {
            const mark = state.coverage === "active" ? "✓" : state.coverage === "wired" ? "·" : "✗";
            ctx.io.line(`    ${mark} ${describeSurface(state)} — ${state.coverage}`);
          }
        }
        ctx.io.line(
          `Queue:   ${depthBefore} queued → ${drain.delivered} delivered, ${depthAfter} remaining` +
            (overflowDropped > 0 ? `, ${overflowDropped} dropped by the queue cap` : ""),
        );
        // The whole point of the notice (gcgp.4): hooks firing into the void is otherwise
        // indistinguishable from no hooks firing at all.
        if (unpaired !== null) ctx.io.line(`⚠ Lost:   ${describeUnpairedActivity(unpaired)}`);
        // gcgp.3: the counterpart signal — hooks that fired and were deliberately not sent.
        if (filtered !== null) ctx.io.line(`Local:   ${describeFilteredActivity(filtered)}`);
      }
      // not-paired → defined non-zero; so is an unreadable store, which is equally "not
      // confirmed working" for a script that branches on it (gcgp.23).
      return paired ? EXIT.OK : EXIT.ERROR;
    },
  };
}
