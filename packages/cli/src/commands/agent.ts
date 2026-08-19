/**
 * `birdybeep agent install|uninstall [all|claude|codex|opencode|cursor|copilot]` (§7.3, §9.4) — the
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
import type { AgentAdapter, InstallResult, TokenStoreOptions } from "@birdybeep/agent-core";
import { claudeCodeAdapter } from "@birdybeep/claude-code";
import { codexAdapter } from "@birdybeep/codex";
import { copilotAdapter } from "@birdybeep/copilot";
import { cursorAdapter } from "@birdybeep/cursor";
import { opencodeAdapter } from "@birdybeep/opencode";

import { isPaired } from "../diagnostics";
import { type Command, type CommandContext, EXIT } from "../framework";

const DEFAULT_ADAPTERS: AgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
  cursorAdapter,
  copilotAdapter,
];

/** CLI short target name → adapter id (the CLI says `claude`, the adapter id is `claude_code`). */
const TARGET_TO_ID: Record<string, string> = {
  claude: "claude_code",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor",
  copilot: "copilot",
};

export const AGENT_TARGETS: readonly string[] = [
  "all",
  "claude",
  "codex",
  "opencode",
  "cursor",
  "copilot",
];

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

/** CLI install target for an adapter id (the CLI says `claude`, the adapter id is `claude_code`). */
export function installTarget(harness: string): string {
  return harness === "claude_code" ? "claude" : harness;
}

async function installSelected(
  adapters: AgentAdapter[],
  ctx: CommandContext,
  tokenOptions: TokenStoreOptions,
): Promise<number> {
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

  // gcgp.5: installing adapters on an unpaired machine wires up hooks that have nowhere to send.
  // `agent install` never mentioned pairing, so the two halves of setup were each silent about
  // the other. Read once, reported at the end where the user is already looking for next steps.
  const paired = await isPaired(tokenOptions);

  if (ctx.flags.json) {
    ctx.io.result({ target, paired, results: outcomes });
    return EXIT.OK;
  }

  if (outcomes.length === 0 || outcomes.every((o) => !o.detected)) {
    ctx.io.line("No supported harnesses detected — nothing to install.");
  }
  for (const o of outcomes) {
    if (!o.detected) {
      // A skip used to be a dead end: no hint that installing the harness and re-running would
      // finish the job, and nothing recorded so a later run picks it up.
      ctx.io.line(
        `–  ${o.displayName}: not detected (skipped) — install it, then run \`birdybeep agent install ${installTarget(o.harness)}\``,
      );
      continue;
    }
    const changed = (o.changedFiles ?? []).length > 0 ? o.changedFiles!.join(", ") : "no changes";
    ctx.io.line(`✓  ${o.displayName}: ${o.status} (${changed})`);
    for (const action of o.requiredActions ?? []) ctx.io.line(`     → ${action}`);
  }
  if (!paired) {
    ctx.io.line(
      "⚠  This machine is not paired, so nothing these hooks produce can reach you. " +
        "Run `birdybeep setup` — it pairs, wires up every agent, and sends a test Beep.",
    );
  }
  return EXIT.OK;
}

interface UninstallOutcome {
  harness: string;
  displayName: string;
  changed: boolean;
  removedFiles: string[];
  restoredFiles: string[];
}

async function uninstallSelected(adapters: AgentAdapter[], ctx: CommandContext): Promise<number> {
  const target = ctx.args[0] ?? "all";
  const selected = selectAdapters(target, adapters);
  if (selected === "unknown") {
    ctx.io.errline(
      `birdybeep agent uninstall: unknown target "${target}" (expected ${AGENT_TARGETS.join("|")}).`,
    );
    return EXIT.USAGE;
  }

  const outcomes: UninstallOutcome[] = [];
  for (const adapter of selected) {
    // Uninstall is safe + idempotent even if nothing is installed (a no-op).
    const result = await adapter.uninstall();
    outcomes.push({
      harness: adapter.id,
      displayName: adapter.displayName,
      changed: result.changed,
      removedFiles: result.removedFiles,
      restoredFiles: result.restoredFiles,
    });
  }

  if (ctx.flags.json) {
    ctx.io.result({ target, results: outcomes });
    return EXIT.OK;
  }
  for (const o of outcomes) {
    if (!o.changed) {
      ctx.io.line(`–  ${o.displayName}: nothing to remove`);
      continue;
    }
    const touched = [...o.removedFiles, ...o.restoredFiles].join(", ") || "config restored";
    ctx.io.line(`✓  ${o.displayName}: removed (${touched})`);
  }
  return EXIT.OK;
}

export interface AgentCommandDeps {
  /** Adapter set (tests inject deterministic detection). Defaults to all supported adapters. */
  adapters?: AgentAdapter[];
  /** Token-store options for the pairing check (tests inject the file fallback). */
  tokenOptions?: TokenStoreOptions;
}

/** Build the `agent` command group (install + uninstall, both via the adapter contract). */
export function createAgentCommand(deps: AgentCommandDeps = {}): Command {
  const adapters = deps.adapters ?? DEFAULT_ADAPTERS;
  const tokenOptions = deps.tokenOptions ?? {};
  return {
    name: "agent",
    summary: "Install or uninstall harness adapters",
    usage: "birdybeep agent <install|uninstall> [all|claude|codex|opencode|cursor|copilot]",
    subcommands: [
      {
        name: "install",
        summary: "Install adapters (all | claude | codex | opencode | cursor | copilot)",
        usage: "birdybeep agent install [all|claude|codex|opencode|cursor|copilot]",
        run: (ctx) => installSelected(adapters, ctx, tokenOptions),
      },
      {
        name: "uninstall",
        summary: "Restore harness config to its pre-install state",
        usage: "birdybeep agent uninstall [all|claude|codex|opencode|cursor|copilot]",
        run: (ctx) => uninstallSelected(adapters, ctx),
      },
    ],
  };
}
