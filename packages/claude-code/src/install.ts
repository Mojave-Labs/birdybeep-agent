/**
 * Claude Code install (§9.5, §7.3): non-destructively patch `~/.claude/settings.json`
 * so the relevant lifecycle hooks invoke `birdybeep hook claude`. Idempotent, backs
 * up the original before first modification, adds ONLY BirdyBeep-managed entries
 * (user hooks preserved), and writes NO token (the command reads the token from the
 * secure store at event time).
 *
 * §9.5 RECONCILIATION (see docs/SPEC.md §9.5): we register the REAL Claude Code hook
 * events BirdyBeep consumes — SessionStart, Notification, PermissionRequest, Stop,
 * StopFailure, SubagentStop, SessionEnd — and the normalizer (CC-NORMALIZE) maps their
 * payloads to §10.1 event types. PermissionRequest and Notification{permission_prompt}
 * both surface approval (de-duplicated at delivery). SessionEnd maps to the `session_ended`
 * type (a coordinated wire-contract addition, lockstep with @birdybeep/shared) so a truly
 * closed session settles terminal instead of lingering non-terminal until it ages out.
 * NOT registered: SubagentStart (not a Claude Code hook event) and TaskCreated/TaskCompleted
 * (deferred for MVP — their targets are not in §10.1).
 *
 * PATH (gcgp.9): `~/.claude/settings.json` is not read by Claude Code alone — Cursor loads it
 * too, as a "claude-user" hook source, and runs it from the Electron main process whose PATH is
 * the launchd environment. That is where a bare `birdybeep hook claude` was logged failing with
 * `zsh:1: command not found: birdybeep` (exit 127). Install therefore writes the launcher
 * agent-core resolves from the running CLI, and REPLACES a managed entry whose command has
 * drifted rather than appending a second one.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import {
  hookCommand,
  type InstallOptions,
  type InstallResult,
  isBirdyBeepHookCommand,
  resolveHookCommand,
} from "@birdybeep/agent-core";

import { claudeSettingsPath } from "./paths";

/**
 * The portable command (no token in it — the hook reads the token from the secure store at
 * event time). This is the documented/example form and the fallback; a real install writes
 * {@link resolveClaudeHookCommand} instead.
 */
export const BIRDYBEEP_HOOK_COMMAND = hookCommand("claude");

/** The command THIS machine's install writes — absolute when the running CLI can be identified. */
export function resolveClaudeHookCommand(): string {
  return resolveHookCommand("claude");
}
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
  "SessionEnd",
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

/** A single BirdyBeep-managed matcher entry, for INSERTING a new one. */
function birdyBeepEntry(command: string): Record<string, unknown> {
  return {
    matcher: "",
    hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
  };
}

/** Is this INNER hook (`{type, command, …}`) the BirdyBeep-managed one? */
export function isBirdyBeepHook(hook: unknown): boolean {
  return isBirdyBeepHookCommand(asRecord(hook)["command"], "claude");
}

/**
 * Does this matcher-entry CONTAIN our hook? Matches ANY command shape we have ever written
 * (bare, absolute, or a since-moved absolute) so uninstall removes it and install repairs it —
 * while never claiming a third party's hook.
 *
 * NOTE the asymmetry, and why the callers below are careful: a Claude matcher entry is
 * `{matcher, hooks: [{type, command}, …]}` and can hold SEVERAL commands, so "this entry
 * contains ours" does NOT mean "this entry is ours". Repairing or removing at entry
 * granularity would delete a user's sibling command that happens to share the matcher.
 */
export function isBirdyBeepEntry(entry: unknown): boolean {
  const hooks = asRecord(entry)["hooks"];
  if (!Array.isArray(hooks)) return false;
  return hooks.some(isBirdyBeepHook);
}

/**
 * Rewrite ONLY our inner hook's command, leaving the matcher entry otherwise byte-identical:
 * the user's sibling commands, the `matcher` itself, our hook's own `timeout`, and any field
 * either object carries that we do not know about all survive. Returns the original object
 * (not a copy) when nothing needs changing, so an unchanged entry is preserved exactly.
 */
function repairEntryCommand(entry: unknown, command: string): { entry: unknown; changed: boolean } {
  const record = asRecord(entry);
  const hooks = record["hooks"];
  if (!Array.isArray(hooks)) return { entry, changed: false };
  let changed = false;
  const nextHooks = (hooks as unknown[]).map((hook): unknown => {
    if (!isBirdyBeepHook(hook)) return hook; // a user's sibling command — never touched
    const inner = asRecord(hook);
    if (inner["command"] === command) return hook;
    changed = true;
    return { ...inner, command }; // preserve type/timeout/unknown fields on OUR hook
  });
  if (!changed) return { entry, changed: false };
  return { entry: { ...record, hooks: nextHooks }, changed: true };
}

/** The BirdyBeep-managed commands currently installed (one per event that carries ours). */
export function installedBirdyBeepCommands(settings: Record<string, unknown>): string[] {
  const hooks = asRecord(settings["hooks"]);
  const commands = new Set<string>();
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const inner = asRecord(entry)["hooks"];
      if (!Array.isArray(inner)) continue;
      for (const hook of inner) {
        const command = asRecord(hook)["command"];
        if (typeof command === "string" && isBirdyBeepHookCommand(command, "claude")) {
          commands.add(command);
        }
      }
    }
  }
  return [...commands];
}

/**
 * Merge BirdyBeep entries into a parsed settings object, preserving everything else. An existing
 * managed hook whose command has drifted (an older bare install, or an absolute path from a CLI
 * that has since moved) is REWRITTEN IN PLACE — never duplicated — so re-running install repairs
 * it. Returns the merged object and whether anything changed (idempotency signal).
 *
 * The repair is surgical at the INNER-HOOK level, not the matcher entry: a user may have added
 * their own command to the same matcher entry as ours, and replacing the entry would delete it.
 */
export function mergeBirdyBeepHooks(
  settings: Record<string, unknown>,
  command: string = BIRDYBEEP_HOOK_COMMAND,
): {
  merged: Record<string, unknown>;
  changed: boolean;
} {
  const hooks = asRecord(settings["hooks"]);
  const nextHooks: Record<string, unknown> = { ...hooks };
  let changed = false;
  for (const event of BIRDYBEEP_HOOK_EVENTS) {
    const current = Array.isArray(nextHooks[event]) ? [...(nextHooks[event] as unknown[])] : [];
    const existing = current.findIndex(isBirdyBeepEntry);
    if (existing < 0) {
      current.push(birdyBeepEntry(command)); // append — never overwrite a user's own hook
      changed = true;
    } else {
      // Repair OUR command only. Everything else in that entry is somebody else's.
      const repaired = repairEntryCommand(current[existing], command);
      if (repaired.changed) {
        current[existing] = repaired.entry;
        changed = true;
      }
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
  const command = options.hookCommand ?? resolveClaudeHookCommand();
  const { merged, changed } = mergeBirdyBeepHooks(parsed, command);

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
      requiredActions: ["Dry run. Re-run without dryRun to apply."],
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
