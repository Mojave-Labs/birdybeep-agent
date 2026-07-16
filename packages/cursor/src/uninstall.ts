/**
 * Cursor uninstall (§7.3): remove EXACTLY the BirdyBeep-managed hook entries CUR-INSTALL
 * added, leaving every user-authored hook and unrelated key untouched. Surgical (preserves
 * post-install user edits): filter our entries out of each event, prune any event array we
 * emptied, drop an emptied `hooks` key. If BirdyBeep created the file from scratch (no
 * backup), remove it — including the `version` scaffold we wrote. The pre-install backup is
 * consumed (deleted) on a successful uninstall. Idempotent: a no-op when nothing of ours is
 * present. In the clean case this returns the file to byte-for-byte original.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import type { UninstallOptions, UninstallResult } from "@birdybeep/agent-core";

import { backupPathFor, isBirdyBeepEntry } from "./install";
import { cursorHooksPath } from "./paths";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Strip BirdyBeep entries from a parsed hooks object; prune emptied event keys + hooks block. */
export function removeBirdyBeepHooks(config: Record<string, unknown>): {
  cleaned: Record<string, unknown>;
  removedAny: boolean;
} {
  const hooks = config["hooks"];
  if (typeof hooks !== "object" || hooks === null) {
    return { cleaned: config, removedAny: false };
  }
  const nextHooks: Record<string, unknown> = {};
  let removedAny = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      nextHooks[event] = entries;
      continue;
    }
    const kept = entries.filter((e) => !isBirdyBeepEntry(e));
    if (kept.length !== entries.length) removedAny = true;
    if (kept.length > 0) nextHooks[event] = kept; // else: prune the now-empty event
  }
  const cleaned: Record<string, unknown> = { ...config };
  if (Object.keys(nextHooks).length > 0) cleaned["hooks"] = nextHooks;
  else delete cleaned["hooks"]; // prune an emptied hooks block
  return { cleaned, removedAny };
}

/**
 * Would the cleaned config be nothing but the `version` scaffold BirdyBeep writes?
 * Used to decide the from-scratch case: when there's no backup, the whole file is ours,
 * so a residual `{ "version": 1 }` must not be left behind — remove the file entirely.
 */
function onlyScaffoldingRemains(cleaned: Record<string, unknown>): boolean {
  return Object.keys(cleaned).every((key) => key === "version");
}

/** Reverse {@link installCursor}. */
export function uninstallCursor(
  options: UninstallOptions = {},
  home: string = homedir(),
): Promise<UninstallResult> {
  const hooksPath = cursorHooksPath(home);
  const backupPath = backupPathFor(hooksPath);

  if (!existsSync(hooksPath)) {
    if (existsSync(backupPath)) rmSync(backupPath, { force: true }); // tidy a stray backup
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] });
  }

  const parsed = asRecord(JSON.parse(readFileSync(hooksPath, "utf8")));
  const { cleaned, removedAny } = removeBirdyBeepHooks(parsed);
  if (!removedAny) {
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] }); // nothing of ours
  }

  if (options.dryRun) {
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [hooksPath] });
  }

  // We created the file from scratch (no backup) and nothing but our scaffold remains → remove it.
  if (onlyScaffoldingRemains(cleaned) && !existsSync(backupPath)) {
    rmSync(hooksPath, { force: true });
    return Promise.resolve({ changed: true, removedFiles: [hooksPath], restoredFiles: [] });
  }

  writeFileSync(hooksPath, `${JSON.stringify(cleaned, null, 2)}\n`);
  if (existsSync(backupPath)) rmSync(backupPath, { force: true }); // backup consumed
  return Promise.resolve({ changed: true, removedFiles: [], restoredFiles: [hooksPath] });
}
