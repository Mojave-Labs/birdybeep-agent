/**
 * Codex install (§9.6, §7.3): non-destructively patch `~/.codex/config.toml` so Codex
 * invokes `birdybeep hook codex` via BOTH mechanisms it supports (verified against the
 * Codex docs): the top-level `notify` program (fires on agent-turn-complete) and
 * lifecycle `[[hooks.X]]` entries (SessionStart, PermissionRequest, PostToolUse,
 * SubagentStart, SubagentStop). The Stop hook is intentionally NOT registered — `notify`
 * already signals turn completion (agent_completed); registering both would double-fire.
 *
 * Idempotent, backs up the original once, adds ONLY BirdyBeep-managed entries (user
 * config preserved), writes NO token (the command reads it at event time), and returns
 * `needs_trust` + the one-time `/hooks` trust instructions (Codex skips untrusted hooks).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { InstallOptions, InstallResult } from "@birdybeep/agent-core";
import { parse, stringify } from "smol-toml";

import { codexConfigFile, type CodexPathOptions } from "./paths";

/** The notify program argv: Codex appends the event JSON as the final argument. */
export const BIRDYBEEP_NOTIFY = ["birdybeep", "hook", "codex"] as const;
/** The command Codex hooks invoke (reads the token at runtime — never embedded here). */
export const BIRDYBEEP_HOOK_COMMAND = "birdybeep hook codex";
export const HOOK_TIMEOUT_SECONDS = 10;
/** The Codex lifecycle hooks BirdyBeep registers (Stop omitted — notify covers turn-complete). */
export const BIRDYBEEP_HOOK_EVENTS = [
  "SessionStart",
  "PermissionRequest",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
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

function notifyIsManaged(value: unknown): boolean {
  return Array.isArray(value) && value.join(" ") === BIRDYBEEP_NOTIFY.join(" ");
}

/** Merge BirdyBeep notify + hook entries into a parsed config, preserving everything else. */
export function mergeCodexConfig(config: Record<string, unknown>): {
  merged: Record<string, unknown>;
  changed: boolean;
} {
  let changed = false;
  const merged: Record<string, unknown> = { ...config };

  if (!notifyIsManaged(merged["notify"])) {
    merged["notify"] = [...BIRDYBEEP_NOTIFY];
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
  return { merged, changed };
}

/** Install BirdyBeep's Codex notify + hooks. Idempotent + non-destructive; returns needs_trust. */
export function installCodex(
  options: InstallOptions & CodexPathOptions = {},
  home: string = homedir(),
): Promise<InstallResult> {
  const configPath = codexConfigFile({ ...options, home: options.home ?? home });
  const backupPath = backupPathFor(configPath);
  const existed = existsSync(configPath);
  const raw = existed ? readFileSync(configPath, "utf8") : "";
  const config = raw.trim().length > 0 ? asRecord(parse(raw)) : {};
  const { merged, changed } = mergeCodexConfig(config);
  const backupFiles = existsSync(backupPath) ? [backupPath] : [];

  if (!changed) {
    return Promise.resolve({
      changed: false,
      changedFiles: [],
      backupFiles,
      requiredActions: [...TRUST_INSTRUCTIONS],
      status: "needs_trust",
    });
  }

  if (options.dryRun) {
    return Promise.resolve({
      changed: false,
      changedFiles: [configPath],
      backupFiles,
      requiredActions: [...TRUST_INSTRUCTIONS],
      status: "needs_trust",
    });
  }

  mkdirSync(dirname(configPath), { recursive: true });
  if (existed && !existsSync(backupPath)) copyFileSync(configPath, backupPath);
  const out = stringify(merged);
  writeFileSync(configPath, out.endsWith("\n") ? out : `${out}\n`);

  return Promise.resolve({
    changed: true,
    changedFiles: [configPath],
    backupFiles: existed ? [backupPath] : [],
    requiredActions: [...TRUST_INSTRUCTIONS], // printed by the CLI
    status: "needs_trust", // not installed until a trusted lifecycle hook fires (CX-TRUST)
  });
}
