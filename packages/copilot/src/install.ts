/**
 * Install a dedicated `~/.copilot/hooks/birdybeep.json`. Copilot combines every JSON file in
 * the hooks directory, so BirdyBeep never merges into or rewrites a user's other hook files.
 * The event name is part of the command because camelCase Copilot payloads do not include an
 * event discriminator.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { InstallOptions, InstallResult } from "@birdybeep/agent-core";

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

export function copilotHookCommand(event: CopilotHookEventName): string {
  return `birdybeep hook copilot ${event}`;
}

export function copilotBackupPath(hooksPath: string): string {
  return `${hooksPath}${COPILOT_BACKUP_SUFFIX}`;
}

export function generatedCopilotHooks(): Record<string, unknown> {
  return {
    version: COPILOT_HOOKS_VERSION,
    hooks: Object.fromEntries(
      COPILOT_HOOK_EVENTS.map((event) => {
        const command = copilotHookCommand(event);
        return [
          event,
          [
            {
              type: "command",
              bash: command,
              powershell: command,
              timeoutSec: COPILOT_HOOK_TIMEOUT_SECONDS,
            },
          ],
        ];
      }),
    ),
  };
}

export function generatedCopilotHooksText(): string {
  return `${JSON.stringify(generatedCopilotHooks(), null, 2)}\n`;
}

/** True only for the exact current managed file (status treats any drift as partial/error). */
export function isCurrentCopilotHooks(input: unknown): boolean {
  try {
    return JSON.stringify(input) === JSON.stringify(generatedCopilotHooks());
  } catch {
    return false;
  }
}

export interface CopilotInstallOptions extends InstallOptions, CopilotPathOptions {}

export function installCopilot(options: CopilotInstallOptions = {}): Promise<InstallResult> {
  const hooksPath = copilotHooksPath(options);
  const backupPath = copilotBackupPath(hooksPath);
  const expected = generatedCopilotHooksText();
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
      requiredActions: ["dry run — re-run without dryRun to apply"],
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
