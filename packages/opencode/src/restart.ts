/**
 * OpenCode restart-to-load handling (§9.7, §8.8). OpenCode loads plugins only at startup
 * (no hot-reload), so writing config/plugin files is NOT enough to call the integration
 * installed — the plugin isn't live until the user restarts OpenCode. We hold the
 * integration in `needs_restart` and flip to `installed` only when a REAL OpenCode event
 * actually reaches the local hook — proof the plugin loaded (an unloaded plugin emits
 * nothing).
 *
 * The signal is a small marker file in the BirdyBeep user data dir (strict perms, never
 * repo-local). `runOpenCodeHook` writes it on the first mappable event; `status()`
 * (OC-STATUS-DOCTOR) reads it; `uninstall()` clears it. The marker carries only a
 * timestamp — never any event content (§15). Mirrors the Codex trust marker.
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  birdyBeepDataDir,
  type HookResult,
  runAgentHook,
  type RunHookOptions,
} from "@birdybeep/agent-core";

import { opencodeAdapter } from "./adapter";

export interface OpenCodeRestartOptions {
  /** Override the BirdyBeep data dir (defaults to `birdyBeepDataDir()`); for hermetic tests. */
  dataDir?: string;
}

/** Path to the marker recording that a real OpenCode event reached the hook (plugin loaded). */
export function opencodeRestartMarkerPath(opts: OpenCodeRestartOptions = {}): string {
  return join(opts.dataDir ?? birdyBeepDataDir(), "integrations", "opencode.seen");
}

/** Has a real OpenCode event ever been processed locally? (drives needs_restart → installed.) */
export function hasOpenCodeEventBeenSeen(opts: OpenCodeRestartOptions = {}): boolean {
  return existsSync(opencodeRestartMarkerPath(opts));
}

/** Record that a real OpenCode event was processed. Idempotent; strict perms (0700/0600). */
export function recordOpenCodeEventSeen(opts: OpenCodeRestartOptions = {}): void {
  const path = opencodeRestartMarkerPath(opts);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 }); // timestamp only — no content
}

/** Clear the marker (used by uninstall). Safe no-op when absent. */
export function clearOpenCodeRestart(opts: OpenCodeRestartOptions = {}): void {
  rmSync(opencodeRestartMarkerPath(opts), { force: true });
}

/** True when the marker grants no group/other access (the §15 strict-perm invariant). */
export function opencodeRestartMarkerIsStrict(opts: OpenCodeRestartOptions = {}): boolean {
  const path = opencodeRestartMarkerPath(opts);
  if (!existsSync(path)) return false;
  if (process.platform === "win32") return true; // POSIX mode bits are N/A on Windows
  return (statSync(path).mode & 0o077) === 0;
}

/**
 * The OpenCode hook entry: run one OpenCode plugin event through the shared pipeline
 * (normalize → dedup → send → fast return) and, because the plugin only loads after a
 * restart, record the needs_restart → installed transition the first time a REAL
 * (mappable) event is processed. A `skipped` outcome (unmappable/dropped) is NOT proof
 * the plugin is live and never flips the state. The CLI `hook opencode` command and the
 * plugin both route through this.
 */
export async function runOpenCodeHook(
  rawInput: unknown,
  options: RunHookOptions & OpenCodeRestartOptions,
): Promise<HookResult> {
  const result = await runAgentHook(opencodeAdapter, rawInput, options);
  if (result.outcome !== "skipped") recordOpenCodeEventSeen(options);
  return result;
}
