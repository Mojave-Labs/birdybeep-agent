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
import { opencodeAdapter } from "@birdybeep/opencode";

import { resolveApiUrl } from "../config";
import { gatherIntegrations, isPaired, localQueueDepth, machineIdentity } from "../diagnostics";
import { type Command, EXIT } from "../framework";

const DEFAULT_ADAPTERS: AgentAdapter[] = [claudeCodeAdapter, codexAdapter, opencodeAdapter];

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
      const drain = await makeSender(resolveApiUrl()).drainNow(); // opportunistic, best-effort
      const depthAfter = localQueueDepth();

      const report = {
        machine,
        paired,
        integrations,
        queue: { depthBefore, delivered: drain.delivered, depthAfter },
      };

      if (ctx.flags.json) {
        ctx.io.result(report);
      } else {
        ctx.io.line(`Machine: ${machine.label} (${machine.os})`);
        ctx.io.line(paired ? "Paired:  yes" : "Paired:  no — run `birdybeep pair`");
        ctx.io.line("Integrations:");
        for (const i of integrations) ctx.io.line(`  ${i.displayName}: ${i.status}`);
        ctx.io.line(
          `Queue:   ${depthBefore} queued → ${drain.delivered} delivered, ${depthAfter} remaining`,
        );
      }
      return paired ? EXIT.OK : EXIT.ERROR; // not-paired → defined non-zero
    },
  };
}
