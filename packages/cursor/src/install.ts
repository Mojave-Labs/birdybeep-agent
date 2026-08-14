/**
 * Cursor install (§9.x, §7.3): non-destructively patch `~/.cursor/hooks.json` so the
 * relevant lifecycle hooks invoke `birdybeep hook cursor`. Idempotent, backs up the
 * original before first modification, adds ONLY BirdyBeep-managed entries (user hooks
 * preserved), and writes NO token (the command reads the token from the secure store at
 * event time).
 *
 * Cursor's hooks file is `{ "version": 1, "hooks": { "<eventName>": [ { command, timeout } ] } }`
 * (each hook command receives the event payload as JSON on stdin — see docs/adapter-development).
 * Unlike Codex, Cursor has NO one-time trust gate — the hooks are live as soon as they are
 * written, so install returns `installed` immediately.
 *
 * PATH (gcgp.9): Cursor runs hooks from the Electron main process, whose PATH is the launchd
 * environment — a bare `birdybeep …` is not found there and the hook dies with exit 127. Install
 * therefore writes the launcher agent-core resolves from the running CLI (absolute node +
 * absolute CLI entry), falling back to the bare command when it cannot be resolved with
 * certainty. Absolute paths go stale, so install REPLACES a managed entry whose command has
 * drifted (rather than appending a second one) and `doctor` flags the stale path.
 *
 * CROSS-REPO LOCKSTEP (§16.4): the private `@birdybeep/shared` HARNESS_IDS must add `"cursor"`
 * before prod ingest accepts cursor events (agent-core's HARNESS_IDS + the schema parity fixture
 * are already updated on this side).
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

import { cursorHooksPath } from "./paths";

/**
 * The portable command (no token in it — the hook reads the token from the secure store at
 * event time). This is the documented/example form and the fallback; a real install writes
 * {@link resolveCursorHookCommand} instead.
 */
export const BIRDYBEEP_HOOK_COMMAND = hookCommand("cursor");

/** The command THIS machine's install writes — absolute when the running CLI can be identified. */
export function resolveCursorHookCommand(): string {
  return resolveHookCommand("cursor");
}
/** Per-hook timeout (seconds) so a slow/offline send never hangs Cursor. */
export const HOOK_TIMEOUT_SECONDS = 30;
/** The hooks-file schema version Cursor expects (the only supported value today). */
export const CURSOR_HOOKS_VERSION = 1;
/**
 * The Cursor hook events BirdyBeep registers. Headless `cursor-agent -p` fires only
 * `sessionStart`/`sessionEnd` today; the IDE fires the rest.
 *
 * NOT the full set. Cursor 3.15.6 defines 21 steps (verified against the shipped
 * `packages/hooks/src/hook-step.ts` enum in `workbench.desktop.main.js`); the nine we leave
 * out — `afterShellExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`,
 * `beforeTabFileRead`, `afterTabFileEdit`, `afterAgentThought`, `preCompact`, `workspaceOpen` —
 * have no §10.1 target, so registering them would spend a hook execution per keystroke-scale
 * event to produce nothing (the `tool_finished` lesson: 88.5% of client traffic, zero pushes).
 *
 * `beforeMCPExecution` IS registered (gcgp.9): it is the direct sibling of
 * `beforeShellExecution` — same blocking permission gate, same `beforeCommandExecutionHookResponse`
 * validator in Cursor's own source — so an MCP permission prompt must beep exactly like a shell
 * one. It cannot add a volume class: Cursor fires `preToolUse` (already registered) for every MCP
 * call too, so `beforeMCPExecution` is a strict subset of traffic we already carry.
 */
export const BIRDYBEEP_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "beforeShellExecution",
  "beforeMCPExecution",
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
function birdyBeepEntry(command: string): Record<string, unknown> {
  return { command, timeout: HOOK_TIMEOUT_SECONDS };
}

/**
 * Is this hook entry one of ours? Matches ANY command shape we have ever written (bare,
 * absolute, or a since-moved absolute) so uninstall removes it and install repairs it —
 * while never claiming a third party's hook.
 */
export function isBirdyBeepEntry(entry: unknown): boolean {
  return isBirdyBeepHookCommand(asRecord(entry)["command"], "cursor");
}

/** The BirdyBeep-managed commands currently installed (one per event that carries ours). */
export function installedBirdyBeepCommands(config: Record<string, unknown>): string[] {
  const hooks = asRecord(config["hooks"]);
  const commands = new Set<string>();
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isBirdyBeepEntry(entry)) continue;
      const command = asRecord(entry)["command"];
      if (typeof command === "string") commands.add(command);
    }
  }
  return [...commands];
}

/**
 * Merge BirdyBeep entries into a parsed hooks object, preserving everything else.
 * Ensures the top-level `version` scaffold exists (Cursor requires it) and appends our entry
 * to each event array without overwriting the user's own hooks. An existing managed entry
 * whose command has drifted (an older bare install, or an absolute path from a CLI that has
 * since moved) is REWRITTEN IN PLACE — never duplicated — so re-running install repairs it.
 * Returns the merged object and whether anything changed (idempotency signal).
 */
export function mergeBirdyBeepHooks(
  config: Record<string, unknown>,
  command: string = BIRDYBEEP_HOOK_COMMAND,
): {
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
    const existing = current.findIndex(isBirdyBeepEntry);
    if (existing < 0) {
      current.push(birdyBeepEntry(command)); // append — never overwrite a user's own hook
      changed = true;
    } else if (asRecord(current[existing])["command"] !== command) {
      current[existing] = birdyBeepEntry(command); // repair in place (stale/legacy command)
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
  const command = options.hookCommand ?? resolveCursorHookCommand();
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
