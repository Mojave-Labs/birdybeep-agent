/**
 * OpenCode uninstall (§7.3, §19.2): remove EXACTLY the BirdyBeep-managed plugin entry
 * OC-INSTALL added to `opencode.json`'s `plugin` array, leaving every user key + plugin
 * untouched, and clear the restart marker. Reversible, non-destructive installs are a
 * core promise of the public repo.
 *
 * Two restore paths (JSON can't be re-serialized byte-for-byte from a differently-formatted
 * original): UNTOUCHED since install (stripping our entry returns the exact pre-install
 * structure) → restore the backup BYTES verbatim; EDITED since install → surgically strip
 * our entry from the CURRENT config and re-serialize, preserving user edits. If BirdyBeep
 * created the file from scratch (no backup) and nothing else remains, the file is removed.
 * Idempotent; the backup is consumed on success.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import type { UninstallOptions, UninstallResult } from "@birdybeep/agent-core";

import { backupPathFor, BIRDYBEEP_PLUGIN_REF } from "./install";
import { opencodeConfigFile, type OpenCodePathOptions } from "./paths";
import { clearOpenCodeRestart, type OpenCodeRestartOptions } from "./restart";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Order-insensitive (objects) / order-sensitive (arrays) deep equality for parsed JSON. */
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

/** Strip the BirdyBeep plugin entry from a parsed config; prune an emptied `plugin` array. */
export function removeBirdyBeepPlugin(config: Record<string, unknown>): {
  cleaned: Record<string, unknown>;
  removedAny: boolean;
} {
  const plugins = config["plugin"];
  if (!Array.isArray(plugins) || !plugins.includes(BIRDYBEEP_PLUGIN_REF)) {
    return { cleaned: config, removedAny: false };
  }
  const kept = plugins.filter((p) => p !== BIRDYBEEP_PLUGIN_REF);
  const cleaned: Record<string, unknown> = { ...config };
  if (kept.length > 0) cleaned["plugin"] = kept;
  else delete cleaned["plugin"]; // prune an emptied plugin array
  return { cleaned, removedAny: true };
}

/** Reverse {@link installOpenCode}. */
export function uninstallOpenCode(
  options: UninstallOptions & OpenCodePathOptions & OpenCodeRestartOptions = {},
  home: string = homedir(),
): Promise<UninstallResult> {
  const configPath = opencodeConfigFile({ ...options, home: options.home ?? home });
  const backupPath = backupPathFor(configPath);

  if (!existsSync(configPath)) {
    if (existsSync(backupPath)) rmSync(backupPath, { force: true }); // tidy a stray backup
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] });
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = raw.trim().length > 0 ? asRecord(JSON.parse(raw)) : {};
  const backupExists = existsSync(backupPath);
  const backupRaw = backupExists ? readFileSync(backupPath, "utf8") : undefined;
  const backupParsed =
    backupRaw !== undefined && backupRaw.trim().length > 0
      ? asRecord(JSON.parse(backupRaw))
      : undefined;

  const { cleaned, removedAny } = removeBirdyBeepPlugin(parsed);
  if (!removedAny) {
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] }); // nothing of ours
  }

  if (options.dryRun) {
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [configPath] });
  }

  // BirdyBeep created the file from scratch (no backup) and nothing else remains → remove it.
  if (Object.keys(cleaned).length === 0 && !backupExists) {
    rmSync(configPath, { force: true });
    clearOpenCodeRestart(options);
    return Promise.resolve({ changed: true, removedFiles: [configPath], restoredFiles: [] });
  }

  // Untouched since install → restore the original bytes verbatim (byte-for-byte).
  if (backupExists && backupRaw !== undefined && deepEqual(cleaned, backupParsed ?? {})) {
    writeFileSync(configPath, backupRaw);
    rmSync(backupPath, { force: true });
    clearOpenCodeRestart(options);
    return Promise.resolve({ changed: true, removedFiles: [], restoredFiles: [configPath] });
  }

  // Edited since install → surgically write the cleaned config, preserving user edits.
  writeFileSync(configPath, `${JSON.stringify(cleaned, null, 2)}\n`);
  if (backupExists) rmSync(backupPath, { force: true }); // backup consumed
  clearOpenCodeRestart(options);
  return Promise.resolve({ changed: true, removedFiles: [], restoredFiles: [configPath] });
}
