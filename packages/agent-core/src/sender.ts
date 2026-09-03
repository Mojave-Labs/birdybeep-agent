/**
 * Event sender (§9.2–9.3): POST a normalized event to `/v1/agent-events` with a
 * SHORT hard timeout; on timeout/network/transient failure, queue it and return
 * fast — never blocking or throwing into the harness. With NO machine token nothing
 * is queued at all: see the `unpaired` outcome below. A token store that ERRORS is a
 * third case, and a transient one — it queues (gcgp.23). The retry-vs-terminal
 * decision keys off the product error-envelope code (mirrored in `api.ts`), so the
 * queue never fills with un-deliverable events. The outcome is RECONCILED against that
 * drain before it is returned (0yk): the drain can deliver the event this very call just
 * enqueued, and reporting "queued" for an event already delivered is how `birdybeep test`
 * came to say "Offline" on a machine that was online. Each send also opportunistically
 * drains the backlog (bounded by count AND by a TOTAL time budget — every harness
 * kills a hook that overruns its registered timeout, and an unbounded 50-entry drain
 * at 3s per attempt could blow well past the tightest of those, erm). The token is
 * read from secure storage at send time and never logged; request bodies/title/body
 * are never logged.
 */
import { type ErrorCode, errorEnvelopeSchema } from "./api";
import { agentEventsResponseSchema, type BirdyBeepAgentEvent } from "./event";
import { DEFAULT_DRAIN_MAX, type DrainOutcome, type DrainResult, LocalEventQueue } from "./queue";
import { readToken, type TokenStoreOptions } from "./token-store";
import { recordUnpairedEvent, type UnpairedNotice } from "./unpaired-notice";

/**
 * A production ingest traverses three Durable Object checks plus D1 before the queue ack. A live
 * healthy request took 5.8s; the old 3s deadline aborted it, queued an event the backend had
 * already accepted, and could cancel the Worker before enqueue. Eight seconds is still a short,
 * hard bound while leaving useful headroom over observed healthy latency.
 */
export const DEFAULT_SEND_TIMEOUT_MS = 8000;
/**
 * Total wall-clock budget for one send() (first attempt + opportunistic drain).
 * Equal to the primary deadline so a fully-spent request is queued and returned rather than
 * immediately retried with a tiny leftover allowance. Managed Claude/Codex/Copilot hooks allow
 * 15s (Cursor 30s; OpenCode is in-process), leaving room for the 3s stdin cap + process startup.
 */
export const DEFAULT_TOTAL_BUDGET_MS = 8000;
/** Stop draining when less than this remains — a send that can't finish shouldn't start. */
const MIN_DRAIN_ATTEMPT_MS = 250;
const AGENT_EVENTS_PATH = "/v1/agent-events";

/**
 * `unpaired` is NOT a flavour of `queued` (birdybeep-agent-gcgp.4). Queueing means "we will
 * deliver this once the network is back"; with no machine token there is nothing to come back
 * to, and pretending otherwise is what let 1138 events pile up unnoticed and made `birdybeep
 * test` report "Offline" on a machine that was online. It is its own outcome so every caller —
 * `test`, `hook`, `doctor` — has to say which of the two actually happened.
 */
export type SendOutcome = "delivered" | "queued" | "dropped" | "unpaired" | "failed";

/**
 * Why a `queued` result was queued (birdybeep-agent-0yk). Every queued outcome used to read as
 * "offline" to callers, so a throttled or 500ing BACKEND told the user to check their network.
 * The three causes have three different fixes: reconnect, wait, unlock the store.
 *
 * - `transport` — the request never got an answer (network error, DNS, timeout). Actually offline.
 * - `backend` — the request REACHED the backend and it asked for a retry (429 / 5xx).
 * - `token_store` — the token store would not answer, so nothing was sent (gcgp.23).
 */
export type QueueCause = "transport" | "backend" | "token_store";

export interface SendResult {
  outcome: SendOutcome;
  status?: number;
  /** Error code from the response envelope, when the server returned one. */
  code?: ErrorCode;
  /**
   * The backend's delivery decision from the 202 body (`notified` / `suppressed` /
   * `deduped`), when parseable. Lets callers (CLI `test`, 9fh) report what actually
   * happened instead of claiming a beep that the backend decided not to push.
   */
  decision?: string;
  /** Result of the opportunistic queue drain performed on this send. */
  drained?: DrainResult;
  /**
   * On an `unpaired` send, the running tally of events discarded for want of a machine token
   * (gcgp.4) — what `status`/`doctor` surface. Absent on every other outcome.
   */
  unpairedNotice?: UnpairedNotice;
  /**
   * Set on a `queued` send whose reason was the TOKEN STORE, not the network
   * (birdybeep-agent-gcgp.23) — carries a short, secret-free reason. Its absence on a `queued`
   * result is what makes "offline" and "could not read the token" different sentences in
   * `test`, `hook` and `doctor`, instead of one wrong one.
   */
  tokenStoreUnavailable?: { reason: string };
  /**
   * Set on every `queued` send: which of the three things above parked the event (0yk). Callers
   * that print copy MUST branch on it — "Offline" is only true for `transport`. It names the
   * NEWEST attempt in the call that reached the backend, so a definitive 429/5xx is not erased by
   * a transport failure on the drain's re-attempt of the same event moments later.
   */
  queueCause?: QueueCause;
}

export interface SenderConfig {
  /** API base URL, e.g. `https://api.birdybeep.com` (or a `wrangler dev` URL). */
  baseUrl: string;
  /** Hard per-request timeout (default 3s) — the harness must not wait longer. */
  timeoutMs?: number;
  /** Total budget for one send()+drain (default 5s) — see module doc (erm). */
  totalBudgetMs?: number;
  /** Queue instance (default a LocalEventQueue at the user data dir). */
  queue?: LocalEventQueue;
  /** Token-store options (inject backend/path in tests). */
  tokenOptions?: TokenStoreOptions;
  /** fetch implementation (injected in tests). */
  fetchImpl?: typeof fetch;
  /** Max queued events drained per send (bounded so the hook returns fast). */
  drainMax?: number;
  /** Injectable clock (ms) for deterministic budget tests. */
  now?: () => number;
  /** Override the unpaired-activity notice path (tests); default `<dataDir>/unpaired-events.json`. */
  noticePath?: string;
}

export interface Sender {
  send(event: BirdyBeepAgentEvent): Promise<SendResult>;
  drainNow(): Promise<DrainResult>;
}

interface Attempt {
  result: DrainOutcome;
  status?: number | undefined;
  code?: ErrorCode | undefined;
  decision?: string | undefined;
  /** Set on a `retry` attempt only: whether the request reached the backend at all (0yk). */
  retryCause?: Extract<QueueCause, "transport" | "backend"> | undefined;
}

/** Decide whether a non-2xx response is worth retrying (queue) or terminal (drop). */
function classify(status: number, code: ErrorCode | undefined): "retry" | "drop" {
  if (code === "rate_limited" || code === "internal_error") return "retry";
  if (code !== undefined) return "drop"; // unauthorized / forbidden / token_revoked / validation_failed / payload_too_large / not_found / quota_exceeded
  if (status >= 500 || status === 429) return "retry"; // transient, no parseable envelope
  return "drop"; // other 4xx
}

/**
 * Extract the ingest decision from a 2xx body by validating it against the formalized
 * cross-repo `agentEventsResponseSchema` (`{ accepted, decision }`, kje4). A body that
 * doesn't match the contract (an older/partial backend, or a decision outside the
 * accept-path enum) yields `undefined` — the send is still `delivered`, callers just
 * can't claim a specific decision. Never throws.
 */
function parseDecision(body: unknown): string | undefined {
  const parsed = agentEventsResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.decision : undefined;
}

export function createSender(config: SenderConfig): Sender {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const totalBudgetMs = config.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const queue = config.queue ?? new LocalEventQueue();
  const fetchImpl = config.fetchImpl ?? fetch;
  const drainMax = config.drainMax ?? DEFAULT_DRAIN_MAX;
  const clock = config.now ?? (() => Date.now());

  async function attempt(
    event: BirdyBeepAgentEvent,
    token: string,
    attemptTimeoutMs: number = timeoutMs,
  ): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${AGENT_EVENTS_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (res.status >= 200 && res.status < 300) {
        // The 202 body carries {accepted, decision} — surface the decision so callers
        // can tell "push enqueued" from "accepted but suppressed/deduped" (9fh).
        const decision = parseDecision(await res.json().catch(() => undefined));
        return { result: "delivered", status: res.status, decision };
      }
      let code: ErrorCode | undefined;
      try {
        const body: unknown = await res.json();
        const parsed = errorEnvelopeSchema.safeParse(body);
        if (parsed.success) code = parsed.data.error.code;
      } catch {
        /* non-JSON error body → fall back to status */
      }
      const result = classify(res.status, code);
      // The request REACHED the backend, so a retry here is the backend's problem, not the
      // network's — the difference the "Offline" copy used to erase (0yk).
      return {
        result,
        status: res.status,
        code,
        ...(result === "retry" ? { retryCause: "backend" as const } : {}),
      };
    } catch {
      return { result: "retry", retryCause: "transport" }; // timeout / transport error → queue
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Drain the backlog until drainMax entries OR the deadline is reached.
   *
   * `watchEventId` names ONE event — the one `send` just enqueued — and reports the attempt the
   * drain made on it, so the caller can say what happened to THAT event instead of to the queue
   * as a whole (0yk). Identity is the event id, which is minted per normalizeEvent call and is
   * therefore unique to the event `send` was handed; counts cannot tell two entries apart.
   */
  async function drainQueue(
    token: string,
    deadline: number,
    watchEventId?: string,
  ): Promise<{ drained: DrainResult; watched?: Attempt }> {
    let watched: Attempt | undefined;
    const drained = await queue.drain(
      async (e) => {
        const remaining = deadline - clock();
        const a = await attempt(e, token, Math.max(1, Math.min(timeoutMs, remaining)));
        if (watchEventId !== undefined && e.event_id === watchEventId) watched = a;
        return a.result;
      },
      { max: drainMax, stopWhen: () => deadline - clock() < MIN_DRAIN_ATTEMPT_MS },
    );
    return watched !== undefined ? { drained, watched } : { drained };
  }

  return {
    async send(event: BirdyBeepAgentEvent): Promise<SendResult> {
      const deadline = clock() + totalBudgetMs;
      const lookup = await readToken(config.tokenOptions);
      if (lookup.state === "unavailable") {
        // The token store FAILED — it did not tell us this machine is unpaired, and gcgp.4's
        // drop is the wrong answer to a question that was never asked (birdybeep-agent-gcgp.23).
        // A locked macOS keychain is the everyday case (screen lock; a login before the first
        // unlock), and it clears by itself, so this is a TRANSIENT failure like any network
        // one: queue, and drain on a later fire when the store answers again.
        //
        // It deliberately does NOT touch the unpaired notice. That file means "events were lost
        // because there was nobody to deliver them to"; nothing here is lost, and telling a
        // paired user their events are gone would be the same wrong diagnosis in a durable form.
        const parked = queue.enqueue(event);
        return {
          outcome: parked ? "queued" : "failed",
          ...(parked ? { queueCause: "token_store" as const } : {}),
          tokenStoreUnavailable: { reason: lookup.reason },
          drained: queue.prune(), // retention + cap still apply (87n) — we cannot drain, only trim
        };
      }
      if (lookup.state === "absent") {
        // NOT PAIRED — a different failure from OFFLINE, and it does not queue (gcgp.4).
        //
        // Queueing here was wrong twice over. It could never drain (no token, no send), so the
        // queue only grew; and if the user later paired, everything in it flushed at once —
        // measured at 1148 POSTs over 23 drain waves from a real backlog, which the backend's
        // per-(integration, session, type) storm summariser turns into push notifications even
        // for event types that would never beep on their own. Nobody who has just paired for the
        // first time wants yesterday's notifications. So the event is dropped deliberately and
        // the fact of it is recorded instead, in one bounded file `status`/`doctor` read back.
        const notice = recordUnpairedEvent(
          event.harness,
          config.noticePath !== undefined
            ? { path: config.noticePath, now: clock }
            : { now: clock },
        );
        // Retention + the count cap still run on this path (87n, gcgp.4): a backlog left by an
        // older CLI must shrink rather than sit there waiting for a first pairing to flush it.
        return {
          outcome: "unpaired",
          drained: queue.prune(),
          ...(notice !== null ? { unpairedNotice: notice } : {}),
        };
      }
      const token = lookup.token;
      const first = await attempt(event, token, Math.min(timeoutMs, totalBudgetMs));
      let outcome: SendOutcome;
      let parked = false;
      if (first.result === "delivered") {
        outcome = "delivered";
      } else if (first.result === "retry") {
        parked = queue.enqueue(event);
        // 9u0: `queued` is a promise that a later hook can retry. If the queue itself is
        // unwritable, the event is gone; report that distinct failure instead of inventing a retry.
        outcome = parked ? "queued" : "failed";
      } else {
        outcome = "dropped"; // terminal reject → do not re-queue
      }

      // The drain that follows can deliver the event we JUST enqueued — it is the newest entry
      // and it runs inside this same call. Deciding the outcome before it ran is what made
      // `birdybeep test` report "Offline — test event queued" for an event it had already
      // delivered (0yk). Watch that one entry through the drain and report what happened to it.
      const { drained, watched } = await drainQueue(
        token,
        deadline,
        parked ? event.event_id : undefined,
      );
      // `watched` is the LAST word on the OUTCOME of this event: the drain re-sent it, so its
      // verdict is newer than the first attempt's. A drop during the drain is reported as a drop —
      // a terminal rejection must never be dressed up as a delivery.
      const final = watched ?? first;
      if (watched !== undefined) {
        outcome =
          watched.result === "delivered"
            ? "delivered"
            : watched.result === "drop"
              ? "dropped"
              : "queued";
      }

      // The CAUSE — and the status/code that evidence it — is chosen SEPARATELY from the outcome,
      // because a transport failure carries no answer at all and the drain makes one likely: its
      // per-attempt timeout is clamped to whatever is left of the total budget, which can be as
      // little as MIN_DRAIN_ATTEMPT_MS. Letting a re-attempt that never left the machine erase the
      // 500 (or the 429) the backend gave us 300ms earlier is the original bug one layer down: the
      // event really is still queued, but the network is not why, and `test` would print "Offline"
      // for a backend that answered inside this very call (0yk). So report the NEWEST attempt that
      // actually REACHED the backend, and fall back to the last attempt only when nothing in this
      // call ever got an answer — which is exactly when `transport` is the truth. An attempt that
      // reached the backend always carries its HTTP status; one that did not never does.
      const evidence = final.status === undefined && first.status !== undefined ? first : final;

      const result: SendResult = { outcome, drained };
      if (outcome === "queued" && evidence.retryCause !== undefined) {
        result.queueCause = evidence.retryCause;
      }
      if (evidence.status !== undefined) result.status = evidence.status;
      if (evidence.code !== undefined) result.code = evidence.code;
      if (evidence.decision !== undefined) result.decision = evidence.decision;
      return result;
    },

    async drainNow(): Promise<DrainResult> {
      const lookup = await readToken(config.tokenOptions);
      // No token, or a store that would not answer: either way there is nothing to send WITH,
      // so the backlog is only trimmed (87n). It stays put for the next drain — which is the
      // point of queueing on an unavailable store rather than dropping (gcgp.23).
      if (lookup.state !== "present") return queue.prune();
      return (await drainQueue(lookup.token, clock() + totalBudgetMs)).drained;
    },
  };
}
