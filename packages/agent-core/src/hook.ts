/**
 * The shared hook pipeline (§9.2–9.3): the core of `birdybeep hook <harness>`.
 * A harness fires a hook → this runs adapter.normalizeEvent (redact/hash/validate)
 * → dedup (collapse a repeat of the same beep) → sender.send (short timeout, queue
 * on failure) → return fast. It must NEVER throw into or block the harness: an
 * unmappable payload is skipped, a duplicate is dropped, and delivery failures queue.
 * The CLI `hook` command (CLI-HOOK) wires stdin + adapter selection around this.
 */
import type { AgentAdapter } from "./adapter";
import { eventIdentity, RecentEventLedger } from "./dedup";
import type { Sender, SendResult } from "./sender";

export type HookOutcome = "delivered" | "queued" | "dropped" | "deduped" | "skipped";

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

  const ledger = options.ledger ?? new RecentEventLedger();
  if (ledger.markAndCheck(eventIdentity(event))) {
    return { outcome: "deduped", eventType: event.event_type }; // same beep already sent → no double-beep
  }

  const send = await options.sender.send(event);
  return { outcome: send.outcome, eventType: event.event_type, send };
}
