/**
 * Codex one-time hook-trust handling (§21.2, §8.8). Codex skips untrusted `[[hooks.X]]`
 * entries until the user reviews + trusts them via `/hooks`, so writing config is NOT
 * enough to call the integration installed. We hold it in `needs_trust` and flip to
 * `installed` only when a real TRUST-GATED HOOK actually reaches the local command —
 * proof the user granted trust (an untrusted hook never fires; the command is never
 * invoked).
 *
 * birdybeep-agent-qyf (security): "a real Codex event" is NOT sufficient. Codex has two
 * separate surfaces here and only ONE is trust-gated:
 *
 *   notify (top-level `notify = [...]`)  — runs on every turn-complete, NO trust needed
 *   [[hooks.X]] lifecycle hooks          — run ONLY after the user trusts them (/hooks)
 *
 * Flipping the marker on a notify fire therefore claimed "installed"/"trusted" on the
 * strength of a path that works without trust, while the security-relevant hook
 * (PermissionRequest → approval_required) was still untrusted and silently dropped —
 * telling the user "you'll be notified when I need approval" when they will not be.
 * So we record trust only for a hook_event_name-keyed payload that actually reached
 * delivery (`delivered` or `queued`).
 *
 * `skipped` (unmappable) and `dropped` (terminal backend reject) are deliberately NOT
 * counted: neither is a clean end-to-end hook fire, and erring toward `needs_trust` is
 * the safe direction — it under-claims rather than falsely promising approval beeps.
 *
 * The signal is a small marker file in the BirdyBeep user data dir (strict perms, never
 * repo-local). `runCodexHook` writes it on the first trust-gated hook; `status()`
 * (CX-STATUS-DOCTOR) reads it; `uninstall()` clears it. The marker carries only a
 * timestamp — never any notification content (§15).
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  birdyBeepDataDir,
  type HookOutcome,
  type HookResult,
  runAgentHook,
  type RunHookOptions,
} from "@birdybeep/agent-core";

import { codexAdapter } from "./adapter";
import { isCodexLifecycleHookPayload } from "./normalize";

/**
 * Outcomes that prove the trust-gated hook command ran end-to-end. `queued` counts: the
 * hook FIRED (which is what trust means) and the event is safely on the local queue —
 * the user merely isn't paired / is offline, which is a separate failure surfaced
 * separately by doctor.
 */
const TRUST_PROVING_OUTCOMES: ReadonlySet<HookOutcome> = new Set<HookOutcome>([
  "delivered",
  "queued",
]);

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
 * (normalize → dedup → send → fast return) and, because Codex's `[[hooks.X]]` entries
 * are trust-gated, record the one-time trust transition the first time a genuinely
 * TRUST-GATED lifecycle hook is processed end-to-end.
 *
 * A notify fire (agent-turn-complete) is NOT proof of trust — Codex runs the notify
 * program without it — so it never flips the state, no matter how cleanly it delivers
 * (birdybeep-agent-qyf). Neither does a `skipped` (unmappable) or `dropped` (terminal
 * reject) outcome. The CLI `hook codex` command and the E2E both call this.
 */
export async function runCodexHook(
  rawInput: unknown,
  options: RunHookOptions & CodexTrustOptions,
): Promise<HookResult> {
  const result = await runAgentHook(codexAdapter, rawInput, options);
  // Trust proof = a trust-gated hook payload AND a clean end-to-end fire. Both halves
  // matter: the notify path satisfies the second but never the first.
  if (isCodexLifecycleHookPayload(rawInput) && TRUST_PROVING_OUTCOMES.has(result.outcome)) {
    recordCodexEventSeen(options);
  }
  return result;
}
