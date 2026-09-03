/** Reverse the dedicated-file Copilot install without touching any foreign hook file. */
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";

import type { UninstallOptions, UninstallResult } from "@birdybeep/agent-core";

import { copilotBackupPath, isManagedCopilotHooks } from "./install";
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
    return isManagedCopilotHooks(JSON.parse(readFileSync(path, "utf8")));
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
    const managedBackup = hasBackup && isBirdyBeepHooksFile(backupPath);
    return Promise.resolve({
      changed: false,
      removedFiles: managedBackup
        ? [backupPath, ...(hasHooks && isBirdyBeepHooksFile(hooksPath) ? [hooksPath] : [])]
        : hasBackup
          ? []
          : [hooksPath],
      restoredFiles: hasBackup && !managedBackup ? [hooksPath] : [],
    });
  }

  if (hasBackup) {
    // 0.8.2 briefly backed up the previous managed 10s file while upgrading it. That backup is
    // ours, not user content: restoring it would leave Copilot invoking BirdyBeep after uninstall.
    if (isBirdyBeepHooksFile(backupPath)) {
      const removedFiles = [backupPath];
      rmSync(backupPath, { force: true });
      if (hasHooks && isBirdyBeepHooksFile(hooksPath)) {
        rmSync(hooksPath, { force: true });
        removedFiles.push(hooksPath);
      }
      return Promise.resolve({ changed: true, removedFiles, restoredFiles: [] });
    }
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
