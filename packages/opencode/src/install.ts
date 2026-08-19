/**
 * OpenCode install (§9.7, §7.3): non-destructively patch `~/.config/opencode/opencode.json`
 * so OpenCode loads the BirdyBeep plugin — by adding ONE BirdyBeep-managed entry to the
 * top-level `"plugin"` array (the documented global plugin-loading mechanism, verified
 * against the OpenCode docs/SDK). Adds only that entry (all user config preserved), backs
 * up the original once, writes NO token, and returns `needs_restart` + the restart
 * instruction — OpenCode loads plugins only at startup, so the integration isn't live
 * until the user relaunches (confirmed by the first real event; OC-STATUS-DOCTOR).
 *
 * PATH (birdybeep-agent-gcgp.16): OpenCode is the one adapter that does not write a command
 * STRING into a harness config — the plugin spawns the CLI itself, at runtime. It resolved
 * `birdybeep` on PATH, so on a machine whose OpenCode is launched without the user's shell PATH
 * the CLI is simply not found and every event is dropped (one stderr line, no beeps, nothing in
 * the config to inspect). Install therefore records the SAME launcher the config-writing adapters
 * bake into their command — absolute Node + absolute CLI entry — in a strict-perm file the plugin
 * reads at spawn time. See {@link writeOpenCodeLauncher}.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import {
  birdyBeepDataDir,
  type HookLauncher,
  type InstallOptions,
  type InstallResult,
  resolveHookLauncher,
} from "@birdybeep/agent-core";

import { opencodeConfigFile, type OpenCodePathOptions } from "./paths";

/**
 * The plugin reference BirdyBeep adds to OpenCode's `plugin` array. OpenCode installs the
 * package (via Bun) and loads its `BirdyBeepPlugin` export. NOTE: the final published
 * plugin-package identity is firmed up in the release epic; it is a single managed
 * constant (snapshot-guarded, reversed by uninstall) so changing it is a one-line edit.
 */
export const BIRDYBEEP_PLUGIN_REF = "@birdybeep/opencode";
export const BACKUP_SUFFIX = ".birdybeep-backup";

/** The one-time restart instructions printed after install (§9.7). */
export const RESTART_INSTRUCTIONS: readonly string[] = [
  "BirdyBeep plugin added to OpenCode.",
  "Restart OpenCode for the plugin to load.",
  "After restart, OpenCode sessions on this machine will be tracked automatically.",
];

export function backupPathFor(configPath: string): string {
  return `${configPath}${BACKUP_SUFFIX}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Override the BirdyBeep data dir holding the launcher record (hermetic tests). */
export interface OpenCodeLauncherOptions {
  dataDir?: string;
}

/**
 * Where install records the absolute launcher the plugin should spawn (gcgp.16). In the BirdyBeep
 * user data dir — never repo-local, and never near the OpenCode config a user might share.
 */
export function opencodeLauncherPath(opts: OpenCodeLauncherOptions = {}): string {
  return join(opts.dataDir ?? birdyBeepDataDir(), "integrations", "opencode-launcher.json");
}

/**
 * The recorded launcher argv, or `null` when there is none we can trust.
 *
 * Validation is the security boundary, because this argv is spawned directly: every element must
 * be a string, and argv[0] must be an ABSOLUTE path to a file that exists. Absolute is what makes
 * the spawn immune to the cwd-binary-planting hijack `safeSpawn` exists to prevent (the plugin's
 * cwd is the repo the developer just opened), and the existence check is what makes a stale
 * record — a moved Node, an uninstalled CLI — fall back to the PATH lookup instead of failing.
 * Contains no token: the CLI reads that from the secure store at send time.
 */
export function readOpenCodeLauncher(opts: OpenCodeLauncherOptions = {}): string[] | null {
  try {
    const raw = readFileSync(opencodeLauncherPath(opts), "utf8");
    const argv = asRecord(JSON.parse(raw))["argv"];
    if (!Array.isArray(argv) || argv.length === 0) return null;
    if (!argv.every((part): part is string => typeof part === "string" && part.length > 0)) {
      return null;
    }
    const [program] = argv;
    if (!isAbsolute(program!) || !existsSync(program!)) return null;
    return argv;
  } catch {
    return null; // absent/unreadable/garbled → the plugin falls back to resolving on PATH
  }
}

/**
 * Record the launcher for the plugin to spawn, or clear a stale record when this install could
 * not resolve one with certainty (a bare launcher tells the plugin nothing it doesn't already do
 * via PATH, and keeping an older machine's absolute paths would be worse than having none).
 * Strict perms (0700 dir / 0600 file), argv only — no token, no cwd, no event content.
 */
export function writeOpenCodeLauncher(
  launcher: HookLauncher,
  opts: OpenCodeLauncherOptions = {},
): boolean {
  const path = opencodeLauncherPath(opts);
  // Only the `runtime` shape is usable: `bare` is the PATH lookup the plugin already does, and an
  // `override` is a raw SHELL string — spawning it would need a shell, reopening the cwd-hijack
  // hole safeSpawn closes, so it is deliberately not honored here.
  const argv = launcher.source === "runtime" ? launcher.argv : undefined;
  if (argv === undefined || argv.length === 0) {
    rmSync(path, { force: true });
    return false;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ argv }, null, 2)}\n`, { mode: 0o600 });
  return true;
}

/** Remove the launcher record (used by uninstall). Safe no-op when absent. */
export function clearOpenCodeLauncher(opts: OpenCodeLauncherOptions = {}): void {
  rmSync(opencodeLauncherPath(opts), { force: true });
}

/** Is the BirdyBeep plugin reference present in a `plugin` array value? */
export function isBirdyBeepPluginConfigured(config: Record<string, unknown>): boolean {
  const plugins = config["plugin"];
  return Array.isArray(plugins) && plugins.includes(BIRDYBEEP_PLUGIN_REF);
}

/** Merge the BirdyBeep plugin entry into a parsed config, preserving everything else. */
export function mergeOpenCodeConfig(config: Record<string, unknown>): {
  merged: Record<string, unknown>;
  changed: boolean;
} {
  if (isBirdyBeepPluginConfigured(config)) return { merged: config, changed: false };
  const existing = config["plugin"];
  const plugins = Array.isArray(existing) ? [...(existing as unknown[])] : [];
  plugins.push(BIRDYBEEP_PLUGIN_REF); // append — never drop a user's own plugin
  return { merged: { ...config, plugin: plugins }, changed: true };
}

/** Install BirdyBeep's OpenCode plugin reference. Idempotent + non-destructive; needs_restart. */
export function installOpenCode(
  options: InstallOptions & OpenCodePathOptions & OpenCodeLauncherOptions = {},
  home: string = homedir(),
): Promise<InstallResult> {
  const configPath = opencodeConfigFile({ ...options, home: options.home ?? home });
  const backupPath = backupPathFor(configPath);
  const existed = existsSync(configPath);
  const raw = existed ? readFileSync(configPath, "utf8") : "";
  const config = raw.trim().length > 0 ? asRecord(JSON.parse(raw)) : {};
  const { merged, changed } = mergeOpenCodeConfig(config);
  const backupFiles = existsSync(backupPath) ? [backupPath] : [];

  // Refreshed on EVERY install, including an idempotent re-run that changes no config: re-running
  // install is exactly how a user repairs a launcher whose Node or CLI has moved (gcgp.16), and
  // the plugin entry being already present must not skip that repair. Never in dryRun.
  if (!options.dryRun) writeOpenCodeLauncher(resolveHookLauncher(), options);

  if (!changed) {
    return Promise.resolve({
      changed: false,
      changedFiles: [],
      backupFiles,
      requiredActions: [...RESTART_INSTRUCTIONS],
      status: "needs_restart",
    });
  }

  if (options.dryRun) {
    return Promise.resolve({
      changed: false,
      changedFiles: [configPath],
      backupFiles,
      requiredActions: [...RESTART_INSTRUCTIONS],
      status: "needs_restart",
    });
  }

  mkdirSync(dirname(configPath), { recursive: true });
  if (existed && !existsSync(backupPath)) copyFileSync(configPath, backupPath);
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);

  return Promise.resolve({
    changed: true,
    changedFiles: [configPath],
    backupFiles: existed ? [backupPath] : [],
    requiredActions: [...RESTART_INSTRUCTIONS], // printed by the CLI
    status: "needs_restart", // not live until OpenCode restarts (OC-STATUS-DOCTOR)
  });
}
