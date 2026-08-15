/**
 * Claude Code uninstall (§7.3): remove EXACTLY the BirdyBeep-managed hooks
 * CC-INSTALL added, leaving every user-authored hook and unrelated key untouched.
 * Surgical (preserves post-install user edits) at the INNER-HOOK level, because a matcher
 * entry can hold several commands and one of them may be the user's: filter our command out
 * of each entry, drop an entry only once it holds nothing else, prune any event array we
 * emptied, drop an emptied `hooks` key. If BirdyBeep
 * created the file from scratch (no backup), remove it. The pre-install backup is
 * consumed (deleted) on a successful uninstall. Idempotent: a no-op when nothing of
 * ours is present. In the clean case this returns the file to byte-for-byte original.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import type { UninstallOptions, UninstallResult } from "@birdybeep/agent-core";

import { backupPathFor, isBirdyBeepHook } from "./install";
import { claudeSettingsPath } from "./paths";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Drop our command from ONE matcher entry. A Claude matcher entry can hold several commands, so
 * removal is at the inner-hook level: if the user put their own command in the same entry as
 * ours, that entry survives with their hook (and its `matcher` and any unknown fields) intact.
 * The entry is dropped only when it held nothing but ours. Returns the ORIGINAL object when we
 * change nothing, so an untouched entry stays byte-identical.
 */
function stripBirdyBeepFromEntry(entry: unknown): { entry: unknown; removed: boolean } {
  const record = asRecord(entry);
  const hooks = record["hooks"];
  if (!Array.isArray(hooks)) return { entry, removed: false };
  const kept = (hooks as unknown[]).filter((hook) => !isBirdyBeepHook(hook));
  if (kept.length === hooks.length) return { entry, removed: false }; // nothing of ours here
  if (kept.length === 0) return { entry: undefined, removed: true }; // purely ours → drop it
  return { entry: { ...record, hooks: kept }, removed: true }; // keep the user's siblings
}

/** Strip BirdyBeep hooks from a parsed settings object; prune emptied entries + hook keys. */
export function removeBirdyBeepHooks(settings: Record<string, unknown>): {
  cleaned: Record<string, unknown>;
  removedAny: boolean;
} {
  const hooks = settings["hooks"];
  if (typeof hooks !== "object" || hooks === null) {
    return { cleaned: settings, removedAny: false };
  }
  const nextHooks: Record<string, unknown> = {};
  let removedAny = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      nextHooks[event] = entries;
      continue;
    }
    const kept: unknown[] = [];
    for (const entry of entries) {
      const stripped = stripBirdyBeepFromEntry(entry);
      if (stripped.removed) removedAny = true;
      if (stripped.entry !== undefined) kept.push(stripped.entry);
    }
    if (kept.length > 0) nextHooks[event] = kept; // else: prune the now-empty event
  }
  const cleaned: Record<string, unknown> = { ...settings };
  if (Object.keys(nextHooks).length > 0) cleaned["hooks"] = nextHooks;
  else delete cleaned["hooks"]; // prune an emptied hooks block
  return { cleaned, removedAny };
}

/** Reverse {@link installClaudeCode}. */
export function uninstallClaudeCode(
  options: UninstallOptions = {},
  home: string = homedir(),
): Promise<UninstallResult> {
  const settingsPath = claudeSettingsPath(home);
  const backupPath = backupPathFor(settingsPath);

  if (!existsSync(settingsPath)) {
    if (existsSync(backupPath)) rmSync(backupPath, { force: true }); // tidy a stray backup
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] });
  }

  const parsed = asRecord(JSON.parse(readFileSync(settingsPath, "utf8")));
  const { cleaned, removedAny } = removeBirdyBeepHooks(parsed);
  if (!removedAny) {
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] }); // nothing of ours
  }

  if (options.dryRun) {
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [settingsPath] });
  }

  // We created the file from scratch (no backup) and nothing else remains → remove it.
  if (Object.keys(cleaned).length === 0 && !existsSync(backupPath)) {
    rmSync(settingsPath, { force: true });
    return Promise.resolve({ changed: true, removedFiles: [settingsPath], restoredFiles: [] });
  }

  writeFileSync(settingsPath, `${JSON.stringify(cleaned, null, 2)}\n`);
  if (existsSync(backupPath)) rmSync(backupPath, { force: true }); // backup consumed
  return Promise.resolve({ changed: true, removedFiles: [], restoredFiles: [settingsPath] });
}
