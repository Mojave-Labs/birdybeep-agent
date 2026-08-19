/** Reverse the dedicated-file Copilot install without touching any foreign hook file. */
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";

import type { UninstallOptions, UninstallResult } from "@birdybeep/agent-core";

import { copilotBackupPath, isCurrentCopilotHooks } from "./install";
import { copilotHooksPath, type CopilotPathOptions } from "./paths";

export interface CopilotUninstallOptions extends UninstallOptions, CopilotPathOptions {}

/**
 * Is the file at `path` one BirdyBeep wrote? Shape-tolerant across launchers (gcgp.16): install
 * bakes THIS machine's resolved launcher into the commands, and uninstall cannot know which one
 * that was — comparing against a single regenerated text would refuse to remove our own file on
 * any machine whose CLI or Node has since moved. Unparseable counts as "not ours" (never delete
 * something we cannot read).
 */
function isBirdyBeepHooksFile(path: string): boolean {
  try {
    return isCurrentCopilotHooks(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return false;
  }
}

export function uninstallCopilot(options: CopilotUninstallOptions = {}): Promise<UninstallResult> {
  const hooksPath = copilotHooksPath(options);
  const backupPath = copilotBackupPath(hooksPath);
  const hasHooks = existsSync(hooksPath);
  const hasBackup = existsSync(backupPath);

  if (!hasHooks && !hasBackup) {
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] });
  }

  if (options.dryRun) {
    return Promise.resolve({
      changed: false,
      removedFiles: hasBackup ? [] : [hooksPath],
      restoredFiles: hasBackup ? [hooksPath] : [],
    });
  }

  if (hasBackup) {
    copyFileSync(backupPath, hooksPath);
    rmSync(backupPath, { force: true });
    return Promise.resolve({ changed: true, removedFiles: [], restoredFiles: [hooksPath] });
  }

  // No backup means BirdyBeep created the dedicated file. Refuse to delete unexpected edits.
  if (hasHooks && !isBirdyBeepHooksFile(hooksPath)) {
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] });
  }

  rmSync(hooksPath, { force: true });
  return Promise.resolve({ changed: true, removedFiles: [hooksPath], restoredFiles: [] });
}
