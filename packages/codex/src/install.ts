/**
 * Codex install (§9.6, §7.3): non-destructively patch `~/.codex/config.toml` so Codex
 * invokes `birdybeep hook codex` from its lifecycle `[[hooks.X]]` entries — SessionStart,
 * PermissionRequest, PostToolUse, SubagentStart, SubagentStop, and Stop (turn complete).
 *
 * BirdyBeep does NOT write the top-level `notify` program (birdybeep-agent-gcgp.2).
 * `notify` is a single-valued scalar: whoever writes last owns it, so setting it destroys
 * whatever integration held it. `[[hooks.X]]` is an array we append to, so every tool can
 * coexist. `Stop` delivers the same turn-complete signal `notify` did — verified firing on
 * both the terminal CLI and the desktop app-server path (birdybeep-agent-gcgp.8) — so the
 * single-slot dependency buys nothing. An older BirdyBeep's own `notify` value is removed
 * on install: it vacates the slot and stops turn-complete double-firing.
 *
 * Idempotent, backs up before every overwrite, adds ONLY BirdyBeep-managed entries (user
 * config preserved), writes NO token (the command reads it at event time), and returns
 * `needs_trust` + the one-time `/hooks` trust instructions (Codex skips untrusted hooks).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { InstallOptions, InstallResult } from "@birdybeep/agent-core";
import { parse, stringify } from "smol-toml";

import { codexConfigFile, type CodexPathOptions } from "./paths";

/**
 * The `notify` argv older BirdyBeep versions wrote into the single notify slot. Kept only
 * to RECOGNIZE and remove our own leftovers — never written (see the file header).
 */
export const LEGACY_BIRDYBEEP_NOTIFY = ["birdybeep", "hook", "codex"] as const;
/** The command Codex hooks invoke (reads the token at runtime — never embedded here). */
export const BIRDYBEEP_HOOK_COMMAND = "birdybeep hook codex";
export const HOOK_TIMEOUT_SECONDS = 10;
/** The Codex lifecycle hooks BirdyBeep registers. `Stop` is the turn-complete signal. */
export const BIRDYBEEP_HOOK_EVENTS = [
  "SessionStart",
  "PermissionRequest",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;
export const BACKUP_SUFFIX = ".birdybeep-backup";

/** The one-time trust instructions printed after install (§9.6). */
export const TRUST_INSTRUCTIONS: readonly string[] = [
  "Codex hooks installed.",
  "Codex may require one-time hook trust. Open Codex and run /hooks.",
  "After trust is granted, Codex sessions on this machine will be tracked automatically.",
];

export function backupPathFor(configPath: string): string {
  return `${configPath}${BACKUP_SUFFIX}`;
}

/** Timestamped backup for a later overwrite, so the canonical backup stays the original. */
function timestampedBackupPathFor(configPath: string, when: Date): string {
  return `${configPath}${BACKUP_SUFFIX}-${when.toISOString().replace(/[:.]/g, "-")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function birdyBeepHookEntry(): Record<string, unknown> {
  return {
    matcher: "",
    hooks: [{ type: "command", command: BIRDYBEEP_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
  };
}

/** Is this matcher-entry one of ours (identified by the managed command)? */
export function isBirdyBeepHookEntry(entry: unknown): boolean {
  const hooks = asRecord(entry)["hooks"];
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => asRecord(h)["command"] === BIRDYBEEP_HOOK_COMMAND);
}

/**
 * Is this `notify` value the argv an older BirdyBeep wrote (i.e. ours to remove)?
 *
 * Element-wise on purpose: joining the array first collapses argument boundaries, so a
 * genuinely different foreign value like `["birdybeep hook", "codex"]` compared equal to
 * ours and was deleted as a leftover.
 */
export function notifyIsLegacyBirdyBeep(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === LEGACY_BIRDYBEEP_NOTIFY.length &&
    value.every((element, i) => element === LEGACY_BIRDYBEEP_NOTIFY[i])
  );
}

export interface MergeResult {
  merged: Record<string, unknown>;
  changed: boolean;
  /** A `notify` owned by someone else, left exactly as found (reported, never touched). */
  foreignNotify?: unknown;
  /** A `notify` an older BirdyBeep displaced, handed back to its owner from the backup. */
  restoredNotify?: unknown;
  /** True when an older BirdyBeep's own `notify` was cleared (restored or simply removed). */
  removedLegacyNotify: boolean;
}

/**
 * Merge BirdyBeep's hook entries into a parsed config, preserving everything else.
 *
 * `backup` is the parsed canonical backup, when one exists. It matters only for the legacy
 * migration: older versions ASSIGNED `notify`, so the program they displaced survives only
 * in that backup. Vacating the slot instead of restoring it would finish destroying the
 * third party's integration rather than undoing it.
 */
export function mergeCodexConfig(
  config: Record<string, unknown>,
  backup?: Record<string, unknown>,
): MergeResult {
  let changed = false;
  let removedLegacyNotify = false;
  let restoredNotify: unknown;
  const merged: Record<string, unknown> = { ...config };

  const notify = merged["notify"];
  if (notifyIsLegacyBirdyBeep(notify)) {
    const displaced = backup?.["notify"];
    if (displaced !== undefined && !notifyIsLegacyBirdyBeep(displaced)) {
      merged["notify"] = displaced; // give the slot back to whoever we took it from
      restoredNotify = displaced;
    } else {
      delete merged["notify"]; // nothing was displaced — just vacate it
    }
    removedLegacyNotify = true;
    changed = true;
  }

  const hooks = asRecord(merged["hooks"]);
  const nextHooks: Record<string, unknown> = { ...hooks };
  for (const event of BIRDYBEEP_HOOK_EVENTS) {
    const current = Array.isArray(nextHooks[event]) ? [...(nextHooks[event] as unknown[])] : [];
    if (!current.some(isBirdyBeepHookEntry)) {
      current.push(birdyBeepHookEntry()); // append — never overwrite a user's own hook
      changed = true;
    }
    nextHooks[event] = current;
  }
  merged["hooks"] = nextHooks;

  const result: MergeResult = { merged, changed, removedLegacyNotify };
  if (restoredNotify !== undefined) result.restoredNotify = restoredNotify;
  if (notify !== undefined && !removedLegacyNotify) result.foreignNotify = notify;
  return result;
}

/** What install tells the user about the notify slot. */
function notifyNotes(merge: MergeResult): string[] {
  if (merge.restoredNotify !== undefined) {
    return [
      `Restored the Codex \`notify\` program an earlier BirdyBeep replaced: ${JSON.stringify(merge.restoredNotify)}`,
    ];
  }
  if (merge.removedLegacyNotify) {
    return [
      "Removed BirdyBeep's `notify` entry from Codex config; turn-complete now comes from the Stop hook.",
    ];
  }
  if (merge.foreignNotify === undefined) return [];
  return [
    `Left the existing Codex \`notify\` program in place: ${JSON.stringify(merge.foreignNotify)}`,
  ];
}

/** Parse the canonical backup, or undefined when it is absent, empty, or unparseable. */
function readBackup(backupPath: string): Record<string, unknown> | undefined {
  if (!existsSync(backupPath)) return undefined;
  try {
    const raw = readFileSync(backupPath, "utf8");
    return raw.trim().length > 0 ? asRecord(parse(raw)) : undefined;
  } catch {
    return undefined; // a corrupt backup must never block an install
  }
}

/** Install BirdyBeep's Codex hooks. Idempotent + non-destructive; returns needs_trust. */
export function installCodex(
  options: InstallOptions & CodexPathOptions = {},
  home: string = homedir(),
): Promise<InstallResult> {
  const configPath = codexConfigFile({ ...options, home: options.home ?? home });
  const backupPath = backupPathFor(configPath);
  const existed = existsSync(configPath);
  const raw = existed ? readFileSync(configPath, "utf8") : "";
  const config = raw.trim().length > 0 ? asRecord(parse(raw)) : {};
  const merge = mergeCodexConfig(config, readBackup(backupPath));
  const requiredActions = [...TRUST_INSTRUCTIONS, ...notifyNotes(merge)];
  const existingBackups = existsSync(backupPath) ? [backupPath] : [];

  if (!merge.changed) {
    return Promise.resolve({
      changed: false,
      changedFiles: [],
      backupFiles: existingBackups,
      requiredActions,
      status: "needs_trust",
    });
  }

  if (options.dryRun) {
    return Promise.resolve({
      changed: false,
      changedFiles: [configPath],
      backupFiles: existingBackups,
      requiredActions,
      status: "needs_trust",
    });
  }

  mkdirSync(dirname(configPath), { recursive: true });
  // Back up before EVERY overwrite (birdybeep-agent-gcgp.2): writing the backup only once
  // meant a value another tool set after the first install could be overwritten with no
  // copy of it anywhere. The canonical backup stays the pre-BirdyBeep original; each later
  // overwrite of different bytes gets its own timestamped copy.
  const backupFiles: string[] = [];
  if (existed) {
    if (!existsSync(backupPath)) {
      copyFileSync(configPath, backupPath);
      backupFiles.push(backupPath);
    } else {
      backupFiles.push(backupPath);
      if (readFileSync(backupPath, "utf8") !== raw) {
        const dated = timestampedBackupPathFor(configPath, new Date());
        copyFileSync(configPath, dated);
        backupFiles.push(dated);
      }
    }
  }
  const out = stringify(merge.merged);
  writeFileSync(configPath, out.endsWith("\n") ? out : `${out}\n`);

  return Promise.resolve({
    changed: true,
    changedFiles: [configPath],
    backupFiles,
    requiredActions, // printed by the CLI
    status: "needs_trust", // not installed until a trusted lifecycle hook fires (CX-TRUST)
  });
}
