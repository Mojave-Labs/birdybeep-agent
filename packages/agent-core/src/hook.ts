/**
 * The shared hook pipeline (§9.2–9.3): the core of `birdybeep hook <harness>`.
 * A harness fires a hook → this runs adapter.normalizeEvent (redact/hash/validate)
 * → event-type filter (gcgp.3) → dedup (collapse a repeat of the same beep) →
 * sender.send (short timeout, queue on failure) → return fast. It must NEVER throw
 * into or block the harness: an unmappable payload is skipped, a `local_only` type is
 * counted and withheld, a duplicate is dropped, and delivery failures queue.
 * The CLI `hook` command (CLI-HOOK) wires stdin + adapter selection around this.
 */
import type { AgentAdapter } from "./adapter";
import {
  APPROVAL_COLLAPSE_WINDOW_MS,
  approvalCollapseIdentity,
  eventIdentity,
  RecentEventLedger,
} from "./dedup";
import { type FilteredActivityOptions, recordFilteredEvent } from "./filtered-activity";
import { shouldSendEventType } from "./notify-matrix";
import type { Sender, SendResult } from "./sender";

export type HookOutcome =
  | "delivered"
  | "queued"
  | "dropped"
  | "deduped"
  | "skipped"
  /**
   * The event type is `local_only` in the notify matrix (gcgp.3): the backend can never push
   * it and needs nothing from it, so it was tallied on this machine and not sent. Distinct
   * from `skipped` (an unmappable payload — nothing was produced) and from `deduped` (a real
   * beep we already sent).
   */
  | "filtered"
  /** No machine token: nothing was sent and nothing was queued (gcgp.4 — see `SendOutcome`). */
  | "unpaired";

export interface HookResult {
  outcome: HookOutcome;
  /** The normalized event type, when the payload was mappable. */
  eventType?: string;
  /** The sender's result, when a send was attempted. */
  send?: SendResult;
}

export interface RunHookOptions {
  sender: Sender;
  /** Dedup ledger (default a RecentEventLedger at the user data dir). */
  ledger?: RecentEventLedger;
  /** Where the locally-filtered tally is written (tests); default `<dataDir>/filtered-events.json`. */
  filteredActivity?: FilteredActivityOptions;
}

/**
 * Run one harness hook fire end-to-end. Returns a {@link HookResult}; never throws.
 */
export async function runAgentHook(
  adapter: AgentAdapter,
  rawInput: unknown,
  options: RunHookOptions,
): Promise<HookResult> {
  let event;
  try {
    event = await adapter.normalizeEvent(rawInput);
  } catch {
    return { outcome: "skipped" }; // unmappable/garbled hook payload → ignore, don't disturb the harness
  }

  // gcgp.3 — BEFORE the ledger and the sender: a type the backend can never push and needs
  // nothing from is tallied here and goes no further. Deliberately ahead of dedup so a flood
  // of them costs one small file write instead of a ledger round-trip plus an HTTP POST, and
  // so it cannot consume the per-machine rate-limit budget that real beeps need.
  if (!shouldSendEventType(event.event_type)) {
    recordFilteredEvent(event.event_type, options.filteredActivity ?? {});
    return { outcome: "filtered", eventType: event.event_type };
  }

  const ledger = options.ledger ?? new RecentEventLedger();
  // Content-aware identity (erm): identical repeats collapse; DIFFERENT notifications
  // of the same type both beep. approval_required ALSO collapses across content within
  // a short window, because one physical approval double-fires two payload shapes with
  // different bodies (Notification{permission_prompt} + PermissionRequest).
  const contentDup = ledger.markAndCheck(eventIdentity(event));
  const approvalDup =
    event.event_type === "approval_required" &&
    ledger.markAndCheck(approvalCollapseIdentity(event), APPROVAL_COLLAPSE_WINDOW_MS);
  if (contentDup || approvalDup) {
    return { outcome: "deduped", eventType: event.event_type }; // same beep already sent → no double-beep
  }

  const send = await options.sender.send(event);
  return { outcome: send.outcome, eventType: event.event_type, send };
}
