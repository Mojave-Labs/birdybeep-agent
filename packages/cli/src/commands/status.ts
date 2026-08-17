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
  describeUnpairedActivity,
  filteredActivity,
  gatherIntegrations,
  isPaired,
  localQueueDepth,
  localQueueOverflowDrops,
  machineIdentity,
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
      const paired = await isPaired(deps.tokenOptions ?? {});
      const integrations = await gatherIntegrations(adapters);
      const depthBefore = localQueueDepth();
      const unpaired = unpairedActivity(); // gcgp.4: events that fired with no token to send them
      const filtered = filteredActivity(); // gcgp.3: events handled locally, never sent
      const drain = await makeSender(resolveApiUrl()).drainNow(); // opportunistic, best-effort
      const depthAfter = localQueueDepth();
      const overflowDropped = localQueueOverflowDrops();

      const report = {
        machine,
        paired,
        integrations,
        queue: { depthBefore, delivered: drain.delivered, depthAfter, overflowDropped },
        ...(unpaired !== null ? { unpairedActivity: unpaired } : {}),
        ...(filtered !== null ? { filteredActivity: filtered } : {}),
      };

      if (ctx.flags.json) {
        ctx.io.result(report);
      } else {
        ctx.io.line(`Machine: ${machine.label} (${machine.os})`);
        ctx.io.line(paired ? "Paired:  yes" : "Paired:  no — run `birdybeep pair`");
        ctx.io.line("Integrations:");
        for (const i of integrations) ctx.io.line(`  ${i.displayName}: ${i.status}`);
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
      return paired ? EXIT.OK : EXIT.ERROR; // not-paired → defined non-zero
    },
  };
}
