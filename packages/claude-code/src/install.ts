/**
 * Claude Code install (§9.5, §7.3): non-destructively patch `~/.claude/settings.json`
 * so the relevant lifecycle hooks invoke `birdybeep hook claude`. Idempotent, backs
 * up the original before first modification, adds ONLY BirdyBeep-managed entries
 * (user hooks preserved), and writes NO token (the command reads the token from the
 * secure store at event time).
 *
 * §9.5 RECONCILIATION (see docs/SPEC.md §9.5): we register the REAL Claude Code hook
 * events BirdyBeep consumes — SessionStart, Notification, PermissionRequest, Stop,
 * StopFailure, SubagentStop — and the normalizer (CC-NORMALIZE) maps their payloads
 * to EXISTING §10.1 event types. PermissionRequest and Notification{permission_prompt}
 * both surface approval (de-duplicated at delivery). NOT registered: SubagentStart
 * (not a Claude Code hook event) and TaskCreated/TaskCompleted (deferred for MVP — their
 * targets task_created/task_completed are not in §10.1; adding them is a coordinated
 * wire-contract change). This is client-side mapping, not a change to the wire contract.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { InstallOptions, InstallResult } from "@birdybeep/agent-core";

import { claudeSettingsPath } from "./paths";

/** The command Claude Code invokes; reads the token at runtime — never embedded here. */
export const BIRDYBEEP_HOOK_COMMAND = "birdybeep hook claude";
/** Per-hook timeout (seconds) so a slow/offline send never hangs Claude Code. */
export const HOOK_TIMEOUT_SECONDS = 10;
/** The REAL Claude Code hook events BirdyBeep registers (see §9.5 reconciliation above). */
export const BIRDYBEEP_HOOK_EVENTS = [
  "SessionStart",
  "Notification",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "SubagentStop",
] as const;

/** Suffix for the one-time backup of the user's original settings. */
export const BACKUP_SUFFIX = ".birdybeep-backup";

export function backupPathFor(settingsPath: string): string {
  return `${settingsPath}${BACKUP_SUFFIX}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A single BirdyBeep-managed matcher entry for one event. */
function birdyBeepEntry(): Record<string, unknown> {
  return {
    matcher: "",
    hooks: [{ type: "command", command: BIRDYBEEP_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
  };
}

/** Is this matcher-entry one of ours (identified by the managed command)? */
export function isBirdyBeepEntry(entry: unknown): boolean {
  const hooks = asRecord(entry)["hooks"];
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => asRecord(h)["command"] === BIRDYBEEP_HOOK_COMMAND);
}

/**
 * Merge BirdyBeep entries into a parsed settings object, preserving everything else.
 * Returns the merged object and whether anything changed (idempotency signal).
 */
export function mergeBirdyBeepHooks(settings: Record<string, unknown>): {
  merged: Record<string, unknown>;
  changed: boolean;
} {
  const hooks = asRecord(settings["hooks"]);
  const nextHooks: Record<string, unknown> = { ...hooks };
  let changed = false;
  for (const event of BIRDYBEEP_HOOK_EVENTS) {
    const current = Array.isArray(nextHooks[event]) ? [...(nextHooks[event] as unknown[])] : [];
    if (!current.some(isBirdyBeepEntry)) {
      current.push(birdyBeepEntry()); // append — never overwrite a user's own hook
      changed = true;
    }
    nextHooks[event] = current;
  }
  return { merged: { ...settings, hooks: nextHooks }, changed };
}

/**
 * Install BirdyBeep's Claude Code hooks. Idempotent + non-destructive: backs up the
 * original once, adds only managed entries, returns the changed files + status.
 */
export function installClaudeCode(
  options: InstallOptions = {},
  home: string = homedir(),
): Promise<InstallResult> {
  const settingsPath = claudeSettingsPath(home);
  const backupPath = backupPathFor(settingsPath);
  const existed = existsSync(settingsPath);
  const raw = existed ? readFileSync(settingsPath, "utf8") : "";
  const parsed = raw.trim().length > 0 ? asRecord(JSON.parse(raw)) : {};
  const { merged, changed } = mergeBirdyBeepHooks(parsed);

  const backupFiles = existsSync(backupPath) ? [backupPath] : [];

  if (!changed) {
    // Already fully managed → no-op (idempotent).
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
      changedFiles: [settingsPath],
      backupFiles,
      requiredActions: ["dry run — re-run without dryRun to apply"],
      status: "installed",
    });
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  if (existed && !existsSync(backupPath)) copyFileSync(settingsPath, backupPath);
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);

  return Promise.resolve({
    changed: true,
    changedFiles: [settingsPath],
    backupFiles: existed ? [backupPath] : [],
    requiredActions: [], // Claude Code reads settings live — no restart/trust needed
    status: "installed",
  });
}
