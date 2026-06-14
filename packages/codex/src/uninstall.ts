/**
 * Codex uninstall (§7.3, §19.2): remove EXACTLY the BirdyBeep-managed `notify` + hook
 * entries CX-INSTALL added, leaving every user-authored key and hook untouched, and
 * clear the trust marker. Reversible, non-destructive installs are a core promise of
 * the public repo.
 *
 * Two restore paths (TOML can't be re-serialized byte-for-byte by hand-written shape):
 *   - UNTOUCHED since install (stripping our entries returns the exact pre-install
 *     structure) → restore the backup BYTES verbatim → byte-for-byte original.
 *   - EDITED since install → surgically strip our entries from the CURRENT config and
 *     re-serialize, preserving the user's post-install edits.
 * Codex `notify` is single-valued, so install overwrote any user `notify` (saved in the
 * backup); uninstall restores the user's original `notify` from the backup. If BirdyBeep
 * created the file from scratch (no backup) and nothing else remains, the file is removed.
 * Idempotent: a no-op when nothing of ours is present. The backup is consumed on success.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import type { UninstallOptions, UninstallResult } from "@birdybeep/agent-core";
import { parse, stringify } from "smol-toml";

import { backupPathFor, BIRDYBEEP_NOTIFY, isBirdyBeepHookEntry } from "./install";
import { codexConfigFile, type CodexPathOptions } from "./paths";
import { clearCodexTrust, type CodexTrustOptions } from "./trust";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function notifyIsManaged(value: unknown): boolean {
  return Array.isArray(value) && value.join(" ") === [...BIRDYBEEP_NOTIFY].join(" ");
}

/** Order-insensitive (objects) / order-sensitive (arrays) deep equality for parsed TOML. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(
      (k) =>
        k in (b as Record<string, unknown>) &&
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/**
 * Strip BirdyBeep's `notify` + hook entries from a parsed config. Restores the user's
 * original (non-BirdyBeep) `notify` from the backup when present; prunes emptied hook
 * events and an emptied `hooks` block.
 */
export function removeBirdyBeepConfig(
  config: Record<string, unknown>,
  backup?: Record<string, unknown>,
): { cleaned: Record<string, unknown>; removedAny: boolean } {
  let removedAny = false;
  const cleaned: Record<string, unknown> = { ...config };

  if (notifyIsManaged(cleaned["notify"])) {
    removedAny = true;
    const original = backup?.["notify"];
    if (original !== undefined && !notifyIsManaged(original)) {
      cleaned["notify"] = original; // restore the user's own notify (install overwrote it)
    } else {
      delete cleaned["notify"];
    }
  }

  const hooks = cleaned["hooks"];
  if (typeof hooks === "object" && hooks !== null && !Array.isArray(hooks)) {
    const nextHooks: Record<string, unknown> = {};
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) {
        nextHooks[event] = entries;
        continue;
      }
      const kept = entries.filter((e) => !isBirdyBeepHookEntry(e));
      if (kept.length !== entries.length) removedAny = true;
      if (kept.length > 0) nextHooks[event] = kept; // else: prune the now-empty event
    }
    if (Object.keys(nextHooks).length > 0) cleaned["hooks"] = nextHooks;
    else delete cleaned["hooks"]; // prune an emptied hooks block
  }

  return { cleaned, removedAny };
}

/** Reverse {@link installCodex}. */
export function uninstallCodex(
  options: UninstallOptions & CodexPathOptions & CodexTrustOptions = {},
  home: string = homedir(),
): Promise<UninstallResult> {
  const configPath = codexConfigFile({ ...options, home: options.home ?? home });
  const backupPath = backupPathFor(configPath);

  if (!existsSync(configPath)) {
    if (existsSync(backupPath)) rmSync(backupPath, { force: true }); // tidy a stray backup
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] });
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = raw.trim().length > 0 ? asRecord(parse(raw)) : {};
  const backupExists = existsSync(backupPath);
  const backupRaw = backupExists ? readFileSync(backupPath, "utf8") : undefined;
  const backupParsed =
    backupRaw !== undefined && backupRaw.trim().length > 0 ? asRecord(parse(backupRaw)) : undefined;

  const { cleaned, removedAny } = removeBirdyBeepConfig(parsed, backupParsed);
  if (!removedAny) {
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] }); // nothing of ours
  }

  if (options.dryRun) {
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [configPath] });
  }

  // BirdyBeep created the file from scratch (no backup) and nothing else remains → remove it.
  if (Object.keys(cleaned).length === 0 && !backupExists) {
    rmSync(configPath, { force: true });
    clearCodexTrust(options);
    return Promise.resolve({ changed: true, removedFiles: [configPath], restoredFiles: [] });
  }

  // Untouched since install → restore the original bytes verbatim (byte-for-byte).
  if (backupExists && backupRaw !== undefined && deepEqual(cleaned, backupParsed ?? {})) {
    writeFileSync(configPath, backupRaw);
    rmSync(backupPath, { force: true });
    clearCodexTrust(options);
    return Promise.resolve({ changed: true, removedFiles: [], restoredFiles: [configPath] });
  }

  // Edited since install → surgically write the cleaned config, preserving user edits.
  const out = stringify(cleaned);
  writeFileSync(configPath, out.endsWith("\n") ? out : `${out}\n`);
  if (backupExists) rmSync(backupPath, { force: true }); // backup consumed
  clearCodexTrust(options);
  return Promise.resolve({ changed: true, removedFiles: [], restoredFiles: [configPath] });
}
