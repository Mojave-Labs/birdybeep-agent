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
 *
 * PATH (birdybeep-agent-gcgp.16): install writes the launcher agent-core resolves from the running
 * CLI (absolute Node + absolute CLI entry) instead of a bare `birdybeep …`. Codex is
 * terminal-launched and usually inherits the user's PATH, but the ChatGPT desktop app spawns it
 * too — and that path has no shell environment, so a bare command dies with exit 127. A managed
 * entry whose command has drifted is REWRITTEN IN PLACE rather than duplicated.
 *
 * MIGRATION (birdybeep-agent-gcgp.15): Codex trusts hooks by HASH, and an untrusted hook is
 * skipped SILENTLY. So any install that rewrites the hook tables — adding `Stop`, or repairing a
 * drifted command — invalidates trust and leaves turn-complete DARK until the user opens Codex
 * and runs `/hooks`. For a first install that is expected and the user is already paying
 * attention; for an UPGRADE it is a regression they would otherwise discover only by noticing
 * beeps stopped. {@link mergeCodexConfig} therefore reports whether BirdyBeep was already
 * configured, and install treats that case as a migration: it drops the trust marker (trust is
 * genuinely gone), records the migration so `doctor` can keep reporting it, and leads its
 * required-actions with an unmissable warning.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  birdyBeepDataDir,
  hookCommand,
  type InstallOptions,
  type InstallResult,
  isBirdyBeepHookCommand,
  resolveHookCommand,
} from "@birdybeep/agent-core";
import { parse, stringify } from "smol-toml";

import { codexConfigFile, type CodexPathOptions } from "./paths";
import { clearCodexTrust, type CodexTrustOptions, hasCodexEventBeenSeen } from "./trust";

/**
 * The `notify` argv older BirdyBeep versions wrote into the single notify slot. Kept only
 * to RECOGNIZE and remove our own leftovers — never written (see the file header).
 */
export const LEGACY_BIRDYBEEP_NOTIFY = ["birdybeep", "hook", "codex"] as const;
/**
 * The portable command (reads the token at runtime — never embedded here). This is the
 * documented/example form and the fallback; a real install writes {@link resolveCodexHookCommand}.
 */
export const BIRDYBEEP_HOOK_COMMAND = hookCommand("codex");

/** The command THIS machine's install writes — absolute when the running CLI can be identified. */
export function resolveCodexHookCommand(): string {
  return resolveHookCommand("codex");
}
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
  "Open Codex and run /hooks. Status changes from needs_trust after a lifecycle hook fires.",
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

/** A single BirdyBeep-managed matcher entry, for INSERTING a new one. */
function birdyBeepHookEntry(command: string): Record<string, unknown> {
  return {
    matcher: "",
    hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
  };
}

/**
 * Is this INNER hook (`{type, command, …}`) the BirdyBeep-managed one? Shape-tolerant across
 * every command form we have ever written (bare, this machine's absolute paths, or absolute
 * paths from a CLI that has since moved), so install repairs and uninstall removes them all.
 */
export function isBirdyBeepHook(hook: unknown): boolean {
  return isBirdyBeepHookCommand(asRecord(hook)["command"], "codex");
}

/**
 * Does this matcher-entry CONTAIN our hook?
 *
 * NOTE the asymmetry, and why the callers are careful (birdybeep-agent-gcgp.19): a Codex matcher
 * entry is `{matcher, hooks: [{type, command}, …]}` and can hold SEVERAL commands, so "this entry
 * contains ours" does NOT mean "this entry is ours". Repairing or removing at ENTRY granularity
 * deletes a user's sibling command that happens to share the matcher — the same silent data loss
 * the Claude adapter had before gcgp.9.
 */
export function isBirdyBeepHookEntry(entry: unknown): boolean {
  const hooks = asRecord(entry)["hooks"];
  if (!Array.isArray(hooks)) return false;
  return hooks.some(isBirdyBeepHook);
}

/**
 * Rewrite ONLY our inner hook's command, leaving the matcher entry otherwise identical: the
 * user's sibling commands, the `matcher` itself, our hook's own `timeout`, and any field either
 * object carries that we do not know about all survive. Returns the ORIGINAL object when nothing
 * needs changing, so an unchanged entry is preserved exactly.
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
export function installedBirdyBeepCommands(config: Record<string, unknown>): string[] {
  const hooks = asRecord(config["hooks"]);
  const commands = new Set<string>();
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const inner = asRecord(entry)["hooks"];
      if (!Array.isArray(inner)) continue;
      for (const hook of inner) {
        const command = asRecord(hook)["command"];
        if (typeof command === "string" && isBirdyBeepHookCommand(command, "codex")) {
          commands.add(command);
        }
      }
    }
  }
  return [...commands];
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
  /**
   * Was BirdyBeep ALREADY configured in this file before the merge (gcgp.15)? True for a legacy
   * `notify` of ours, or for any pre-existing managed hook entry. This is what separates an
   * UPGRADE — where the user has working beeps today and is about to silently lose turn-complete
   * until they re-trust — from a first install, where `needs_trust` is expected.
   */
  previouslyConfigured: boolean;
  /** Hook events that gained a BirdyBeep entry (empty on an idempotent re-run). */
  addedEvents: string[];
  /** Hook events whose managed command was rewritten in place — trust dies with the hash. */
  repairedEvents: string[];
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
  command: string = BIRDYBEEP_HOOK_COMMAND,
): MergeResult {
  let changed = false;
  let removedLegacyNotify = false;
  let restoredNotify: unknown;
  const merged: Record<string, unknown> = { ...config };
  const addedEvents: string[] = [];
  const repairedEvents: string[] = [];

  // Sampled BEFORE anything is touched — this is the upgrade-vs-first-install question (gcgp.15).
  const hadHookEntries = Object.values(asRecord(config["hooks"])).some(
    (entries) => Array.isArray(entries) && entries.some(isBirdyBeepHookEntry),
  );
  const previouslyConfigured = hadHookEntries || notifyIsLegacyBirdyBeep(config["notify"]);

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
    const existing = current.findIndex(isBirdyBeepHookEntry);
    if (existing < 0) {
      current.push(birdyBeepHookEntry(command)); // append — never overwrite a user's own hook
      addedEvents.push(event);
      changed = true;
    } else {
      // Repair OUR command only. Everything else in that entry is somebody else's (gcgp.19).
      const repaired = repairEntryCommand(current[existing], command);
      if (repaired.changed) {
        current[existing] = repaired.entry;
        repairedEvents.push(event);
        changed = true;
      }
    }
    nextHooks[event] = current;
  }
  merged["hooks"] = nextHooks;

  const result: MergeResult = {
    merged,
    changed,
    removedLegacyNotify,
    previouslyConfigured,
    addedEvents,
    repairedEvents,
  };
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

// --- MIGRATION: turn-complete goes dark until /hooks (birdybeep-agent-gcgp.15) --------------
//
// Codex trusts `[[hooks.X]]` entries by HASH and skips an untrusted one SILENTLY — no dialog, no
// error, no fire. So the moment install rewrites the hook tables (gcgp.2 added `Stop`; gcgp.16
// rewrites the command) an existing user's turn-complete stops, with nothing to tell them why.
//
// WHY THE LEGACY `notify` IS STILL REMOVED, rather than left as a safety net until `Stop` is
// observed trusted. Three reasons, in order of weight:
//   1. It is not ours to keep. `notify` is a single-valued scalar; older BirdyBeep versions
//      ASSIGNED it and displaced whatever third-party integration held it. Install restores that
//      program from the backup (gcgp.2). Keeping our value to protect OUR signal would keep
//      THEIR integration dark indefinitely — trading a bounded gap of ours for an unbounded one
//      of someone else's.
//   2. There is no safe moment to remove it later. Trust is observed by the hook runtime, not by
//      install, so "until Stop is trusted" means either the user re-runs install for no visible
//      reason, or the fire-and-forget hook path rewrites `~/.codex/config.toml` at event time —
//      which must return fast, races Codex's own reads, and (fatally) would invalidate the very
//      hook hashes it was waiting on. The net would in practice become permanent.
//   3. The net has a hole anyway. The legacy value is `["birdybeep","hook","codex"]` — the bare
//      command gcgp.16 exists to replace. On the ChatGPT-desktop path that spawns Codex without a
//      shell environment, it is exactly as unfindable as the hook command would be.
// Dedup would probably have absorbed a double-fire — `Stop` and notify `agent-turn-complete` map
// to the same type with byte-identical title+body, so the identity collapses IF Codex's notify
// `thread-id` equals the hook `session_id` — but that equality is unverified here, and it does
// not change the decision above.
//
// So: keep the removal, and make the gap LOUD and SHORT instead.

/** Override the BirdyBeep data dir holding the migration marker (hermetic tests). */
export type CodexMigrationOptions = CodexTrustOptions;

/** Path to the marker recording that an install migrated an already-configured user (gcgp.15). */
export function codexMigrationMarkerPath(opts: CodexMigrationOptions = {}): string {
  return join(opts.dataDir ?? birdyBeepDataDir(), "integrations", "codex-migration.json");
}

/** Has an install migrated a previously-configured Codex user on this machine? */
export function codexMigrationRecorded(opts: CodexMigrationOptions = {}): boolean {
  return existsSync(codexMigrationMarkerPath(opts));
}

/**
 * Record the migration. Strict perms (0700 dir / 0600 file); carries a timestamp and the hook
 * event NAMES that need re-trusting — never any notification content (§15).
 */
export function recordCodexMigration(events: readonly string[], opts: CodexMigrationOptions = {}) {
  const path = codexMigrationMarkerPath(opts);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), events }, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Clear the migration marker (used by uninstall). Safe no-op when absent. */
export function clearCodexMigration(opts: CodexMigrationOptions = {}): void {
  rmSync(codexMigrationMarkerPath(opts), { force: true });
}

/**
 * Is turn-complete currently DARK because of a migration (gcgp.15)? THE PREDICATE `doctor` AND
 * `status` SHOULD REPORT — see the note on this ticket for the sibling wiring.
 *
 * Composed rather than stored, so it clears itself: install drops the trust marker when it
 * migrates (trust really is gone), and the first trust-gated hook that fires re-records it
 * through the existing `runCodexHook` path. No new runtime bookkeeping, and no way for the
 * warning to outlive the condition it describes.
 */
export function codexTurnCompleteIsDark(opts: CodexMigrationOptions = {}): boolean {
  return codexMigrationRecorded(opts) && !hasCodexEventBeenSeen(opts);
}

/** The unmissable warning install leads with, and `doctor` repeats, while turn-complete is dark. */
export const MIGRATION_WARNING: readonly string[] = [
  "Codex hooks changed and must be trusted again.",
  "Open Codex, run /hooks, and approve the BirdyBeep entries. Codex completion notifications are disabled until then.",
];

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
  options: InstallOptions & CodexPathOptions & CodexTrustOptions = {},
  home: string = homedir(),
): Promise<InstallResult> {
  const configPath = codexConfigFile({ ...options, home: options.home ?? home });
  const backupPath = backupPathFor(configPath);
  const existed = existsSync(configPath);
  const raw = existed ? readFileSync(configPath, "utf8") : "";
  const config = raw.trim().length > 0 ? asRecord(parse(raw)) : {};
  const command = options.hookCommand ?? resolveCodexHookCommand();
  const merge = mergeCodexConfig(config, readBackup(backupPath), command);

  // A MIGRATION is an already-configured user whose hook tables we are about to rewrite: the
  // rewrite invalidates Codex's trust hashes, so their turn-complete stops until they run /hooks
  // (gcgp.15). A first install also lands untrusted, but that user is watching the install output
  // and has never had beeps to lose — only the upgrade needs the alarm.
  const migrating =
    merge.previouslyConfigured &&
    (merge.addedEvents.length > 0 || merge.repairedEvents.length > 0 || merge.removedLegacyNotify);
  const requiredActions = [
    ...(migrating ? MIGRATION_WARNING : []),
    ...TRUST_INSTRUCTIONS,
    ...notifyNotes(merge),
  ];
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

  if (migrating) {
    // The marker keeps `doctor` reporting the dark window after this output scrolls away, and
    // dropping the trust marker makes status() honest: a marker set before these hashes changed
    // no longer proves anything, and leaving it would report "hooks trusted" while Codex silently
    // skips them. `runCodexHook` re-records it on the first genuinely trusted fire.
    recordCodexMigration([...merge.addedEvents, ...merge.repairedEvents], options);
    clearCodexTrust(options);
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
