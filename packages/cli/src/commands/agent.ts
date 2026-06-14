/**
 * `birdybeep agent install|uninstall [all|claude|codex|opencode]` (§7.3, §9.4) — the
 * once-per-machine setup half: detect supported harnesses and run each adapter's
 * idempotent, non-destructive install/uninstall. Adds ONLY BirdyBeep-managed entries
 * (existing config backed up + preserved), the installed config invokes
 * `birdybeep hook <harness>`, and NO durable token is ever written into harness/repo
 * config — the hook reads the token from the secure store at runtime. Prints the changed
 * files + any required user action (Codex `/hooks` trust, OpenCode restart).
 *
 * Built as a factory with an injectable adapter set so tests exercise the REAL adapter
 * installs under a temp HOME with deterministic detection.
 */
import type { AgentAdapter, InstallResult } from "@birdybeep/agent-core";
import { claudeCodeAdapter } from "@birdybeep/claude-code";
import { codexAdapter } from "@birdybeep/codex";
import { opencodeAdapter } from "@birdybeep/opencode";

import { type Command, type CommandContext, EXIT } from "../framework";

const DEFAULT_ADAPTERS: AgentAdapter[] = [claudeCodeAdapter, codexAdapter, opencodeAdapter];

/** CLI short target name → adapter id (the CLI says `claude`, the adapter id is `claude_code`). */
const TARGET_TO_ID: Record<string, string> = {
  claude: "claude_code",
  codex: "codex",
  opencode: "opencode",
};

export const AGENT_TARGETS: readonly string[] = ["all", "claude", "codex", "opencode"];

/** Resolve a target to the adapter(s) it names, or `"unknown"` for a bad target. */
export function selectAdapters(
  target: string,
  adapters: AgentAdapter[],
): AgentAdapter[] | "unknown" {
  if (target === "all") return adapters;
  const id = TARGET_TO_ID[target];
  if (id === undefined) return "unknown";
  return adapters.filter((a) => a.id === id);
}

interface InstallOutcome {
  harness: string;
  displayName: string;
  detected: boolean;
  status?: InstallResult["status"];
  changedFiles?: string[];
  backupFiles?: string[];
  requiredActions?: string[];
}

async function installSelected(adapters: AgentAdapter[], ctx: CommandContext): Promise<number> {
  const target = ctx.args[0] ?? "all";
  const selected = selectAdapters(target, adapters);
  if (selected === "unknown") {
    ctx.io.errline(
      `birdybeep agent install: unknown target "${target}" (expected ${AGENT_TARGETS.join("|")}).`,
    );
    return EXIT.USAGE;
  }

  const outcomes: InstallOutcome[] = [];
  for (const adapter of selected) {
    const detection = await adapter.detect();
    if (!detection.detected) {
      outcomes.push({ harness: adapter.id, displayName: adapter.displayName, detected: false });
      continue;
    }
    const result = await adapter.install();
    outcomes.push({
      harness: adapter.id,
      displayName: adapter.displayName,
      detected: true,
      status: result.status,
      changedFiles: result.changedFiles,
      backupFiles: result.backupFiles,
      requiredActions: result.requiredActions,
    });
  }

  if (ctx.flags.json) {
    ctx.io.result({ target, results: outcomes });
    return EXIT.OK;
  }

  if (outcomes.length === 0 || outcomes.every((o) => !o.detected)) {
    ctx.io.line("No supported harnesses detected — nothing to install.");
  }
  for (const o of outcomes) {
    if (!o.detected) {
      ctx.io.line(`–  ${o.displayName}: not detected (skipped)`);
      continue;
    }
    const changed = (o.changedFiles ?? []).length > 0 ? o.changedFiles!.join(", ") : "no changes";
    ctx.io.line(`✓  ${o.displayName}: ${o.status} (${changed})`);
    for (const action of o.requiredActions ?? []) ctx.io.line(`     → ${action}`);
  }
  return EXIT.OK;
}

export interface AgentCommandDeps {
  /** Adapter set (tests inject deterministic detection). Defaults to the three real adapters. */
  adapters?: AgentAdapter[];
  /** Uninstall run handler (wired by OC/diq — `birdybeep agent uninstall`). */
  uninstallRun?: (ctx: CommandContext) => Promise<number> | number;
}

/** Build the `agent` command group (install implemented; uninstall lands in birdybeep-agent-diq). */
export function createAgentCommand(deps: AgentCommandDeps = {}): Command {
  const adapters = deps.adapters ?? DEFAULT_ADAPTERS;
  return {
    name: "agent",
    summary: "Install or uninstall harness adapters",
    usage: "birdybeep agent <install|uninstall> [all|claude|codex|opencode]",
    subcommands: [
      {
        name: "install",
        summary: "Install adapters (all | claude | codex | opencode)",
        usage: "birdybeep agent install [all|claude|codex|opencode]",
        run: (ctx) => installSelected(adapters, ctx),
      },
      {
        name: "uninstall",
        summary: "Restore harness config to its pre-install state",
        usage: "birdybeep agent uninstall [all|claude|codex|opencode]",
        run:
          deps.uninstallRun ??
          ((ctx) => {
            ctx.io.errline("birdybeep: this command is not implemented yet (birdybeep-agent-diq).");
            return EXIT.ERROR;
          }),
      },
    ],
  };
}
