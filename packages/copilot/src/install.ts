/**
 * Install a dedicated `~/.copilot/hooks/birdybeep.json`. Copilot combines every JSON file in
 * the hooks directory, so BirdyBeep never merges into or rewrites a user's other hook files.
 * The event name is part of the command because camelCase Copilot payloads do not include an
 * event discriminator.
 *
 * PATH (birdybeep-agent-gcgp.16): a bare `birdybeep …` only resolves when Copilot happens to run
 * hooks with the user's shell PATH. When it does not, the hook dies with exit 127 — and writing
 * just the CLI's absolute path fails the same way, because the published bin's shebang is
 * `#!/usr/bin/env node`. Install therefore writes the launcher agent-core resolves from the
 * running CLI (absolute node + absolute CLI entry), falling back to the bare command when it
 * cannot be resolved with certainty.
 *
 * Copilot's entry is the only one carrying TWO command strings, and they are NOT the same text:
 * `powershell` needs the call operator `&` and single-quoted paths, because PowerShell parses a
 * line beginning with a double-quoted string as an expression (it would print the path instead of
 * running it) and interpolates `$…` inside double quotes (`C:\$Recycle.Bin\node.exe` would lose
 * `$Recycle`). agent-core's `powershellLauncher` owns that shape.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  BARE_HOOK_LAUNCHER,
  hookCommand,
  type HookLauncher,
  type InstallOptions,
  type InstallResult,
  isBirdyBeepHookCommand,
  powershellLauncher,
  resolveHookLauncher,
} from "@birdybeep/agent-core";

import { copilotHooksPath, type CopilotPathOptions } from "./paths";

export const COPILOT_HOOKS_VERSION = 1;
export const COPILOT_HOOK_TIMEOUT_SECONDS = 10;
export const COPILOT_HOOK_EVENTS = [
  "sessionStart",
  "userPromptSubmitted",
  "preToolUse",
  "postToolUse",
  "agentStop",
  "subagentStop",
  "errorOccurred",
  "sessionEnd",
] as const;
export type CopilotHookEventName = (typeof COPILOT_HOOK_EVENTS)[number];

export const COPILOT_BACKUP_SUFFIX = ".birdybeep-backup";

export function isCopilotHookEventName(value: string | undefined): value is CopilotHookEventName {
  return COPILOT_HOOK_EVENTS.some((event) => event === value);
}

/**
 * The portable bash command for one event (no token in it — the hook reads the token from the
 * secure store at event time). This is the documented/example form and the fallback; a real
 * install writes {@link copilotHookCommands} with the resolved launcher instead.
 */
export function copilotHookCommand(
  event: CopilotHookEventName,
  launcher: string = BARE_HOOK_LAUNCHER.launcher,
): string {
  return hookCommand("copilot", [event], launcher);
}

/** The two command strings one Copilot hook entry carries. */
export interface CopilotHookCommands {
  readonly bash: string;
  readonly powershell: string;
}

/** Both shell forms of the managed command for one event. */
export function copilotHookCommands(
  event: CopilotHookEventName,
  launcher: HookLauncher = BARE_HOOK_LAUNCHER,
): CopilotHookCommands {
  return {
    bash: copilotHookCommand(event, launcher.launcher),
    powershell: copilotHookCommand(event, powershellLauncher(launcher)),
  };
}

/** The launcher THIS machine's install writes — absolute when the running CLI can be identified. */
export function resolveCopilotLauncher(): HookLauncher {
  return resolveHookLauncher();
}

export function copilotBackupPath(hooksPath: string): string {
  return `${hooksPath}${COPILOT_BACKUP_SUFFIX}`;
}

export function generatedCopilotHooks(
  launcher: HookLauncher = BARE_HOOK_LAUNCHER,
): Record<string, unknown> {
  return {
    version: COPILOT_HOOKS_VERSION,
    hooks: Object.fromEntries(
      COPILOT_HOOK_EVENTS.map((event) => {
        const { bash, powershell } = copilotHookCommands(event, launcher);
        return [
          event,
          [{ type: "command", bash, powershell, timeoutSec: COPILOT_HOOK_TIMEOUT_SECONDS }],
        ];
      }),
    ),
  };
}

export function generatedCopilotHooksText(launcher: HookLauncher = BARE_HOOK_LAUNCHER): string {
  return `${JSON.stringify(generatedCopilotHooks(launcher), null, 2)}\n`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Is this entry the BirdyBeep-managed hook for `event`, in ANY launcher shape we have written? */
function isBirdyBeepEntry(entry: unknown, event: CopilotHookEventName): boolean {
  const record = asRecord(entry);
  if (record["type"] !== "command") return false;
  if (record["timeoutSec"] !== COPILOT_HOOK_TIMEOUT_SECONDS) return false;
  // BOTH shells must name our command for this event: a half-rewritten file is drift, not ours.
  return (
    isBirdyBeepHookCommand(record["bash"], "copilot", [event]) &&
    isBirdyBeepHookCommand(record["powershell"], "copilot", [event])
  );
}

/**
 * Is this the current managed file? Shape-TOLERANT across launchers (gcgp.16): the file may carry
 * a bare command from an older install, this machine's absolute paths, or absolute paths from a
 * CLI that has since moved — all three are still ours, and status must not call a healthy install
 * "error" merely because the launcher differs. A STALE absolute path is a separate signal,
 * reported via {@link installedBirdyBeepCommands} + agent-core's `staleHookCommandPaths`, rather
 * than by pretending the file is foreign.
 *
 * Everything else stays strict: the version, the exact event set, one entry per event, and the
 * managed timeout — any other drift is still partial/error.
 */
export function isCurrentCopilotHooks(input: unknown): boolean {
  const record = asRecord(input);
  if (record["version"] !== COPILOT_HOOKS_VERSION) return false;
  const hooks = asRecord(record["hooks"]);
  if (Object.keys(hooks).length !== COPILOT_HOOK_EVENTS.length) return false;
  return COPILOT_HOOK_EVENTS.every((event) => {
    const entries = hooks[event];
    return Array.isArray(entries) && entries.length === 1 && isBirdyBeepEntry(entries[0], event);
  });
}

/**
 * Every BirdyBeep-managed command string in the file, both shells (gcgp.16). `doctor` feeds these
 * to agent-core's `staleHookCommandPaths` to spot a launcher whose absolute paths have moved —
 * the exit-127 failure that is otherwise invisible.
 */
export function installedBirdyBeepCommands(input: unknown): string[] {
  const hooks = asRecord(asRecord(input)["hooks"]);
  const commands = new Set<string>();
  for (const event of COPILOT_HOOK_EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const shell of ["bash", "powershell"] as const) {
        const command = asRecord(entry)[shell];
        if (typeof command === "string" && isBirdyBeepHookCommand(command, "copilot", [event])) {
          commands.add(command);
        }
      }
    }
  }
  return [...commands];
}

export interface CopilotInstallOptions extends InstallOptions, CopilotPathOptions {}

export function installCopilot(options: CopilotInstallOptions = {}): Promise<InstallResult> {
  const hooksPath = copilotHooksPath(options);
  const backupPath = copilotBackupPath(hooksPath);
  // An explicit `hookCommand` is a raw launcher string (the E2E rigs and the documented
  // BIRDYBEEP_HOOK_COMMAND escape hatch both arrive with no argv to re-quote), so it is passed
  // through to BOTH shells verbatim — same contract as an override.
  const launcher: HookLauncher =
    options.hookCommand !== undefined
      ? { launcher: options.hookCommand, source: "override" }
      : resolveCopilotLauncher();
  const expected = generatedCopilotHooksText(launcher);
  const existed = existsSync(hooksPath);
  const current = existed ? readFileSync(hooksPath, "utf8") : undefined;
  const backupFiles = existsSync(backupPath) ? [backupPath] : [];

  if (current === expected) {
    return Promise.resolve({
      changed: false,
      changedFiles: [],
      backupFiles,
      requiredActions: [],
      status: "installed",
    });
  }

  if (options.dryRun) {
    return Promise.resolve({
      changed: false,
      changedFiles: [hooksPath],
      backupFiles,
      requiredActions: ["Dry run. Re-run without dryRun to apply."],
      status: "installed",
    });
  }

  mkdirSync(dirname(hooksPath), { recursive: true });
  if (existed && !existsSync(backupPath)) copyFileSync(hooksPath, backupPath);
  writeFileSync(hooksPath, expected, { mode: 0o600 });

  return Promise.resolve({
    changed: true,
    changedFiles: [hooksPath],
    backupFiles: existed ? [backupPath] : [],
    requiredActions: [],
    status: "installed",
  });
}
