/**
 * OpenCode install (§9.7, §7.3): non-destructively patch `~/.config/opencode/opencode.json`
 * so OpenCode loads the BirdyBeep plugin — by adding ONE BirdyBeep-managed entry to the
 * top-level `"plugin"` array (the documented global plugin-loading mechanism, verified
 * against the OpenCode docs/SDK). Adds only that entry (all user config preserved), backs
 * up the original once, writes NO token, and returns `needs_restart` + the restart
 * instruction — OpenCode loads plugins only at startup, so the integration isn't live
 * until the user relaunches (confirmed by the first real event; OC-STATUS-DOCTOR).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { InstallOptions, InstallResult } from "@birdybeep/agent-core";

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
  options: InstallOptions & OpenCodePathOptions = {},
  home: string = homedir(),
): Promise<InstallResult> {
  const configPath = opencodeConfigFile({ ...options, home: options.home ?? home });
  const backupPath = backupPathFor(configPath);
  const existed = existsSync(configPath);
  const raw = existed ? readFileSync(configPath, "utf8") : "";
  const config = raw.trim().length > 0 ? asRecord(JSON.parse(raw)) : {};
  const { merged, changed } = mergeOpenCodeConfig(config);
  const backupFiles = existsSync(backupPath) ? [backupPath] : [];

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
