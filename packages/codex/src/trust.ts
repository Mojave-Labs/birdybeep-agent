/**
 * Codex one-time hook-trust handling (§21.2, §8.8). Codex skips untrusted `[[hooks.X]]`
 * entries until the user reviews + trusts them via `/hooks`, so writing config is NOT
 * enough to call the integration installed. We hold it in `needs_trust` and flip to
 * `installed` only when a REAL Codex event actually reaches the local hook — proof the
 * user granted trust (an untrusted hook never fires; the command is never invoked).
 *
 * The signal is a small marker file in the BirdyBeep user data dir (strict perms, never
 * repo-local). `runCodexHook` writes it on the first mappable event; `status()`
 * (CX-STATUS-DOCTOR) reads it; `uninstall()` clears it. The marker carries only a
 * timestamp — never any notification content (§15).
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  birdyBeepDataDir,
  type HookResult,
  runAgentHook,
  type RunHookOptions,
} from "@birdybeep/agent-core";

import { codexAdapter } from "./adapter";

export interface CodexTrustOptions {
  /** Override the BirdyBeep data dir (defaults to `birdyBeepDataDir()`); for hermetic tests. */
  dataDir?: string;
}

/** Path to the marker recording that a real Codex event reached the hook (trust granted). */
export function codexTrustMarkerPath(opts: CodexTrustOptions = {}): string {
  return join(opts.dataDir ?? birdyBeepDataDir(), "integrations", "codex.seen");
}

/** Has a real Codex event ever been processed locally? (drives needs_trust → installed.) */
export function hasCodexEventBeenSeen(opts: CodexTrustOptions = {}): boolean {
  return existsSync(codexTrustMarkerPath(opts));
}

/** Record that a real Codex event was processed. Idempotent; strict perms (0700 dir / 0600 file). */
export function recordCodexEventSeen(opts: CodexTrustOptions = {}): void {
  const path = codexTrustMarkerPath(opts);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Timestamp only — never notification content. New Date is fine in package runtime.
  writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
}

/** Clear the trust marker (used by uninstall). Safe no-op when absent. */
export function clearCodexTrust(opts: CodexTrustOptions = {}): void {
  rmSync(codexTrustMarkerPath(opts), { force: true });
}

/** True when the marker grants no group/other access (the §15 strict-perm invariant). */
export function codexTrustMarkerIsStrict(opts: CodexTrustOptions = {}): boolean {
  const path = codexTrustMarkerPath(opts);
  if (!existsSync(path)) return false;
  if (process.platform === "win32") return true; // POSIX mode bits are N/A on Windows
  return (statSync(path).mode & 0o077) === 0;
}

/**
 * The Codex hook entry: run one Codex notify/hook fire through the shared pipeline
 * (normalize → dedup → send → fast return) and, because Codex hooks are trust-gated,
 * record the one-time trust transition the first time a REAL (mappable) event is
 * processed. A `skipped` outcome (unmappable/garbled) is NOT proof of trust and never
 * flips the state. The CLI `hook codex` command and the E2E both call this.
 */
export async function runCodexHook(
  rawInput: unknown,
  options: RunHookOptions & CodexTrustOptions,
): Promise<HookResult> {
  const result = await runAgentHook(codexAdapter, rawInput, options);
  if (result.outcome !== "skipped") recordCodexEventSeen(options);
  return result;
}
