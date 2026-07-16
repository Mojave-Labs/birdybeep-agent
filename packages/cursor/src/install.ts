/**
 * Cursor install (§9.x, §7.3): non-destructively patch `~/.cursor/hooks.json` so the
 * relevant lifecycle hooks invoke `birdybeep hook cursor`. Idempotent, backs up the
 * original before first modification, adds ONLY BirdyBeep-managed entries (user hooks
 * preserved), and writes NO token (the command reads the token from the secure store at
 * event time).
 *
 * Cursor's hooks file is `{ "version": 1, "hooks": { "<eventName>": [ { command, timeout } ] } }`
 * (each hook command receives the event payload as JSON on stdin — see docs/adapter-development).
 * We register the FULL documented event set so IDE users are covered, even though headless
 * `cursor-agent -p` only fires `sessionStart` + `sessionEnd` today (a version-dependent subset).
 * Unlike Codex, Cursor has NO one-time trust gate — the hooks are live as soon as they are
 * written, so install returns `installed` immediately.
 *
 * CROSS-REPO LOCKSTEP (§16.4): the private `@birdybeep/shared` HARNESS_IDS must add `"cursor"`
 * before prod ingest accepts cursor events (agent-core's HARNESS_IDS + the schema parity fixture
 * are already updated on this side).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { InstallOptions, InstallResult } from "@birdybeep/agent-core";

import { cursorHooksPath } from "./paths";

/** The command Cursor invokes; reads the token at runtime — never embedded here. */
export const BIRDYBEEP_HOOK_COMMAND = "birdybeep hook cursor";
/** Per-hook timeout (seconds) so a slow/offline send never hangs Cursor. */
export const HOOK_TIMEOUT_SECONDS = 30;
/** The hooks-file schema version Cursor expects (the only supported value today). */
export const CURSOR_HOOKS_VERSION = 1;
/**
 * The full documented Cursor hook event set BirdyBeep registers. Headless `cursor-agent -p`
 * fires only `sessionStart`/`sessionEnd` today; the IDE fires the rest. Registering them all
 * is forward-compat — an event with no §10.1 mapping simply normalizes to "skipped".
 */
export const BIRDYBEEP_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "beforeShellExecution",
  "stop",
  "afterAgentResponse",
  "subagentStart",
  "subagentStop",
] as const;

/** Suffix for the one-time backup of the user's original hooks file. */
export const BACKUP_SUFFIX = ".birdybeep-backup";

export function backupPathFor(hooksPath: string): string {
  return `${hooksPath}${BACKUP_SUFFIX}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A single BirdyBeep-managed hook entry for one Cursor event. */
function birdyBeepEntry(): Record<string, unknown> {
  return { command: BIRDYBEEP_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS };
}

/** Is this hook entry one of ours (identified by the managed command)? */
export function isBirdyBeepEntry(entry: unknown): boolean {
  return asRecord(entry)["command"] === BIRDYBEEP_HOOK_COMMAND;
}

/**
 * Merge BirdyBeep entries into a parsed hooks object, preserving everything else.
 * Ensures the top-level `version` scaffold exists (Cursor requires it) and appends our
 * entry to each event array without overwriting the user's own hooks. Returns the merged
 * object and whether anything changed (idempotency signal).
 */
export function mergeBirdyBeepHooks(config: Record<string, unknown>): {
  merged: Record<string, unknown>;
  changed: boolean;
} {
  const merged: Record<string, unknown> = { ...config };
  let changed = false;

  // Cursor requires `"version": 1`. Add it only when absent so an existing version is
  // preserved byte-for-byte (never rewrite a user's top-level value).
  if (merged["version"] === undefined) {
    merged["version"] = CURSOR_HOOKS_VERSION;
    changed = true;
  }

  const hooks = asRecord(merged["hooks"]);
  const nextHooks: Record<string, unknown> = { ...hooks };
  for (const event of BIRDYBEEP_HOOK_EVENTS) {
    const current = Array.isArray(nextHooks[event]) ? [...(nextHooks[event] as unknown[])] : [];
    if (!current.some(isBirdyBeepEntry)) {
      current.push(birdyBeepEntry()); // append — never overwrite a user's own hook
      changed = true;
    }
    nextHooks[event] = current;
  }
  merged["hooks"] = nextHooks;
  return { merged, changed };
}

/**
 * Install BirdyBeep's Cursor hooks. Idempotent + non-destructive: backs up the original
 * once, adds only managed entries, returns the changed files + status. No trust/restart
 * gate — Cursor reads hooks.json live, so status is `installed` immediately.
 */
export function installCursor(
  options: InstallOptions = {},
  home: string = homedir(),
): Promise<InstallResult> {
  const hooksPath = cursorHooksPath(home);
  const backupPath = backupPathFor(hooksPath);
  const existed = existsSync(hooksPath);
  const raw = existed ? readFileSync(hooksPath, "utf8") : "";
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
      changedFiles: [hooksPath],
      backupFiles,
      requiredActions: ["dry run — re-run without dryRun to apply"],
      status: "installed",
    });
  }

  mkdirSync(dirname(hooksPath), { recursive: true });
  if (existed && !existsSync(backupPath)) copyFileSync(hooksPath, backupPath);
  writeFileSync(hooksPath, `${JSON.stringify(merged, null, 2)}\n`);

  return Promise.resolve({
    changed: true,
    changedFiles: [hooksPath],
    backupFiles: existed ? [backupPath] : [],
    requiredActions: [], // Cursor reads hooks.json live — no restart/trust needed
    status: "installed",
  });
}
