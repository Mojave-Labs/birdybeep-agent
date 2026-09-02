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
 * the command and was processed as a recognized hook.
 *
 * `skipped` (unmappable) and `dropped` (terminal backend reject) are deliberately NOT
 * counted: neither is a clean end-to-end hook fire. The one narrow exception is a known
 * ChatGPT internal result: it is intentionally skipped before delivery, but its recognized
 * lifecycle envelope still proves Codex ran the trust-gated command.
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
import { isCodexInternalResultPayload, isCodexLifecycleHookPayload } from "./normalize";

/**
 * Outcomes that prove the trust-gated hook command ran end-to-end. `queued` counts: the
 * hook FIRED (which is what trust means) and the event is safely on the local queue —
 * the user merely is offline, which is a separate failure surfaced separately by doctor.
 * `unpaired` counts for the same reason (gcgp.4): Codex ran our command, which is the whole
 * question trust answers; that the event went nowhere for want of a token is `doctor`'s
 * business, and withholding trust would make `birdybeep pair` silently re-open the /hooks
 * prompt on a machine that had already granted it.
 *
 * `filtered` counts for the same reason again, and it is LOAD-BEARING (gcgp.3): PostToolUse
 * is the highest-frequency trust-gated hook Codex fires, and its `tool_finished` is now
 * withheld client-side. Leaving `filtered` out would make a trusted install look untrusted
 * until some OTHER hook happened to fire — the marker asks whether Codex RAN our command,
 * and a filtered event is proof that it did.
 */
const TRUST_PROVING_OUTCOMES: ReadonlySet<HookOutcome> = new Set<HookOutcome>([
  "delivered",
  "queued",
  "unpaired",
  "filtered",
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
 * (birdybeep-agent-qyf). Neither does a `skipped` unmappable payload or `dropped` terminal
 * reject. A recognized internal result is intentionally skipped but still proves the
 * lifecycle command fired. The CLI `hook codex` command and the E2E both call this.
 */
export async function runCodexHook(
  rawInput: unknown,
  options: RunHookOptions & CodexTrustOptions,
): Promise<HookResult> {
  const internalResult = isCodexInternalResultPayload(rawInput);
  const result = await runAgentHook(codexAdapter, rawInput, options);
  // Trust proof = a trust-gated hook payload AND a recognized fire. Known internal-result
  // hooks are suppressed before delivery, but reaching this command still proves trust.
  if (
    isCodexLifecycleHookPayload(rawInput) &&
    (TRUST_PROVING_OUTCOMES.has(result.outcome) || internalResult)
  ) {
    recordCodexEventSeen(options);
  }
  return result;
}
