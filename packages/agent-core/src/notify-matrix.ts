/**
 * The §10.5 notify matrix (mirrored) and the client-side send filter derived from it
 * (birdybeep-agent-gcgp.3).
 *
 * WHY THE CLIENT NEEDS THIS AT ALL. Until gcgp.3 the hook pipeline sent every event an
 * adapter could produce and let the backend decide. For one event type that was measurably
 * wasteful: `tool_finished` (Codex `PostToolUse`) was 1016 of 1148 events — 88.5% — from
 * 18.45h of one user's real work, and the server suppresses it before any user setting can
 * apply. Those POSTs cost bandwidth, D1/KV/DO work per event, and — because the per-machine
 * rate limit is 60/60s — they crowd out events that WOULD have beeped.
 *
 * ONE TABLE, THREE ANSWERS. {@link EVENT_DISPOSITION} is the only hand-maintained matrix in
 * this repo; {@link DEFAULT_NOTIFY} and {@link LOCAL_ONLY_EVENT_TYPES} are both derived from
 * it, so the filter can never disagree with the mirrored matrix. It is typed
 * `Record<BirdyBeepEventType, …>`, so adding an event type to `BIRDYBEEP_EVENT_TYPES`
 * without classifying it here is a compile error.
 *
 * LOCKSTEP (§16.4). The `notify` column MIRRORS the product `@birdybeep/shared`
 * `DEFAULT_NOTIFY` — the source of truth. The vendored snapshot in
 * `__fixtures__/product-default-notify.json` is a byte-for-byte copy of the product's own
 * `packages/shared/src/__fixtures__/default-notify.json`, and `notify-matrix.test.ts` fails
 * if this table drifts from it. Change the product matrix → update both snapshots.
 *
 * "NEVER NOTIFIES" IS NOT "USELESS" — this is the part that decides what may be dropped.
 * The worker does four things with an accepted event, and only one of them is the push:
 *   1. upserts the agent_integration — and for Codex that is how a `needs_trust` install is
 *      PROMOTED to `installed` (a delivered lifecycle-hook event is the only proof the user
 *      granted `/hooks` trust). The proving types are session_started / session_resumed /
 *      approval_required / tool_finished / subagent_started / subagent_completed.
 *   2. upserts the agent_session — status, cwd, repo, branch: the mobile sessions list.
 *   3. touches machine + integration `last_seen` (the "last seen 2m ago" line).
 *   4. runs the notify decision, which is the only step `DEFAULT_NOTIFY` gates.
 * So the filter is NOT "drop everything with notify=false". A type is `local_only` only when
 * it also carries no session/trust/liveness value AND its volume scales with TOOL CALLS
 * rather than with sessions or turns — which is exactly the family that produced the 88.5%.
 * Every other non-notifying type is `server_only` and still goes, with its reason below.
 */
import { BIRDYBEEP_EVENT_TYPES, type BirdyBeepEventType } from "./primitives";

/**
 * What the client does with an event type:
 *   - `notify`      the server may push it (mirrors DEFAULT_NOTIFY = true) — always sent.
 *   - `server_only` the server never pushes it, but still needs it (session lifecycle,
 *                   Codex trust promotion, liveness) — always sent.
 *   - `local_only`  the server never pushes it AND needs nothing from it — counted on this
 *                   machine (see `filtered-activity.ts`) and never sent.
 */
export type EventDisposition = "notify" | "server_only" | "local_only";

/**
 * The single hand-maintained matrix. Order follows §10.1 so it reads next to
 * `BIRDYBEEP_EVENT_TYPES` and the product's `DEFAULT_NOTIFY`.
 */
export const EVENT_DISPOSITION: Record<BirdyBeepEventType, EventDisposition> = {
  // Creates the session row the mobile list renders, and is Codex's most reliable
  // trust-proving event (it fires once per session, whether or not a prompt ever appears).
  session_started: "server_only",
  session_resumed: "server_only", // same, for `--resume`
  session_active: "server_only", // OpenCode/Copilot liveness heartbeat — keeps `last_seen` fresh
  needs_input: "notify",
  approval_required: "notify",
  agent_idle: "notify",
  agent_completed: "notify",
  agent_failed: "notify",
  test_failed: "notify",
  // The per-tool-call family: one event per tool invocation, so volume tracks tool use, not
  // work. Nothing server-side reads them that another event does not already carry — the
  // session already exists (session_started), its status is already `running`, and Codex
  // trust is already proven by session_started. This is the 88.5%.
  tool_started: "local_only",
  tool_finished: "local_only",
  // Low volume (one pair per subtask) and Codex-trust-proving; the session status they carry
  // is the only signal a long subagent run produces.
  subagent_started: "server_only",
  subagent_completed: "server_only",
  // No shipped adapter emits it. Sent rather than dropped: a third-party or future adapter
  // using it as a lifecycle marker should still reach the session/liveness path.
  custom: "server_only",
  test: "notify", // the `birdybeep test` diagnostic beep (9fh)
  session_ended: "server_only", // terminal marker — settles the session into the "ended" bucket
};

/**
 * §10.5 default notify-or-suppress, MIRRORED from the product `@birdybeep/shared`.
 * Derived from {@link EVENT_DISPOSITION} so the client filter and the mirrored matrix are
 * the same table read two ways.
 */
export const DEFAULT_NOTIFY: Record<BirdyBeepEventType, boolean> = Object.fromEntries(
  BIRDYBEEP_EVENT_TYPES.map((type) => [type, EVENT_DISPOSITION[type] === "notify"]),
) as Record<BirdyBeepEventType, boolean>;

/** Event types the hook pipeline counts locally and never sends. */
export const LOCAL_ONLY_EVENT_TYPES: readonly BirdyBeepEventType[] = BIRDYBEEP_EVENT_TYPES.filter(
  (type) => EVENT_DISPOSITION[type] === "local_only",
);

const LOCAL_ONLY = new Set<string>(LOCAL_ONLY_EVENT_TYPES);

/** Can the server ever push this event type? (the mirrored §10.5 answer) */
export function isNotifiableEventType(eventType: string): boolean {
  return DEFAULT_NOTIFY[eventType as BirdyBeepEventType] === true;
}

/**
 * Should the hook pipeline send this event to the backend?
 *
 * FAIL-OPEN on an unrecognized type: dropping something we cannot classify would be a silent
 * lost beep, and the server validates the vocabulary anyway. Only a type explicitly marked
 * `local_only` above is ever withheld.
 */
export function shouldSendEventType(eventType: string): boolean {
  return !LOCAL_ONLY.has(eventType);
}
