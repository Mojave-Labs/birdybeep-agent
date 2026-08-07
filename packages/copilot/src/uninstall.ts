/** Reverse the dedicated-file Copilot install without touching any foreign hook file. */
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";

import type { UninstallOptions, UninstallResult } from "@birdybeep/agent-core";

import { copilotBackupPath, generatedCopilotHooksText } from "./install";
import { copilotHooksPath, type CopilotPathOptions } from "./paths";

export interface CopilotUninstallOptions extends UninstallOptions, CopilotPathOptions {}

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
  if (hasHooks && readFileSync(hooksPath, "utf8") !== generatedCopilotHooksText()) {
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] });
  }

  rmSync(hooksPath, { force: true });
  return Promise.resolve({ changed: true, removedFiles: [hooksPath], restoredFiles: [] });
}
