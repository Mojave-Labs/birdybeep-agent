/**
 * Event sender (§9.2–9.3): POST a normalized event to `/v1/agent-events` with a
 * SHORT hard timeout; on timeout/network/transient failure, queue it and return
 * fast — never blocking or throwing into the harness. The retry-vs-terminal
 * decision keys off the product error-envelope code (mirrored in `api.ts`), so the
 * queue never fills with un-deliverable events. Each send also opportunistically
 * drains the backlog (bounded). The token is read from secure storage at send time
 * and never logged; request bodies/title/body are never logged.
 */
import { type ErrorCode, errorEnvelopeSchema } from "./api";
import type { BirdyBeepAgentEvent } from "./event";
import { DEFAULT_DRAIN_MAX, type DrainOutcome, type DrainResult, LocalEventQueue } from "./queue";
import { getToken, type TokenStoreOptions } from "./token-store";

export const DEFAULT_SEND_TIMEOUT_MS = 3000;
const AGENT_EVENTS_PATH = "/v1/agent-events";

export type SendOutcome = "delivered" | "queued" | "dropped";

export interface SendResult {
  outcome: SendOutcome;
  status?: number;
  /** Error code from the response envelope, when the server returned one. */
  code?: ErrorCode;
  /** Result of the opportunistic queue drain performed on this send. */
  drained?: DrainResult;
}

export interface SenderConfig {
  /** API base URL, e.g. `https://api.birdybeep.com` (or a `wrangler dev` URL). */
  baseUrl: string;
  /** Hard per-request timeout (default 3s) — the harness must not wait longer. */
  timeoutMs?: number;
  /** Queue instance (default a LocalEventQueue at the user data dir). */
  queue?: LocalEventQueue;
  /** Token-store options (inject backend/path in tests). */
  tokenOptions?: TokenStoreOptions;
  /** fetch implementation (injected in tests). */
  fetchImpl?: typeof fetch;
  /** Max queued events drained per send (bounded so the hook returns fast). */
  drainMax?: number;
}

export interface Sender {
  send(event: BirdyBeepAgentEvent): Promise<SendResult>;
  drainNow(): Promise<DrainResult>;
}

interface Attempt {
  result: DrainOutcome;
  status?: number | undefined;
  code?: ErrorCode | undefined;
}

const EMPTY_DRAIN: DrainResult = { delivered: 0, dropped: 0, kept: 0, pruned: 0 };

/** Decide whether a non-2xx response is worth retrying (queue) or terminal (drop). */
function classify(status: number, code: ErrorCode | undefined): "retry" | "drop" {
  if (code === "rate_limited" || code === "internal_error") return "retry";
  if (code !== undefined) return "drop"; // unauthorized / forbidden / token_revoked / validation_failed / payload_too_large / not_found / quota_exceeded
  if (status >= 500 || status === 429) return "retry"; // transient, no parseable envelope
  return "drop"; // other 4xx
}

export function createSender(config: SenderConfig): Sender {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const queue = config.queue ?? new LocalEventQueue();
  const fetchImpl = config.fetchImpl ?? fetch;
  const drainMax = config.drainMax ?? DEFAULT_DRAIN_MAX;

  async function attempt(event: BirdyBeepAgentEvent, token: string): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${AGENT_EVENTS_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (res.status >= 200 && res.status < 300) {
        await res.arrayBuffer().catch(() => undefined); // drain body
        return { result: "delivered", status: res.status };
      }
      let code: ErrorCode | undefined;
      try {
        const body: unknown = await res.json();
        const parsed = errorEnvelopeSchema.safeParse(body);
        if (parsed.success) code = parsed.data.error.code;
      } catch {
        /* non-JSON error body → fall back to status */
      }
      return { result: classify(res.status, code), status: res.status, code };
    } catch {
      return { result: "retry" }; // timeout / transport error → queue
    } finally {
      clearTimeout(timer);
    }
  }

  function drainQueue(token: string): Promise<DrainResult> {
    return queue.drain((e) => attempt(e, token).then((a) => a.result), { max: drainMax });
  }

  return {
    async send(event: BirdyBeepAgentEvent): Promise<SendResult> {
      const token = await getToken(config.tokenOptions);
      if (token === null) {
        queue.enqueue(event); // not paired yet → retry after `birdybeep login`
        return { outcome: "queued" };
      }
      const a = await attempt(event, token);
      let outcome: SendOutcome;
      if (a.result === "delivered") {
        outcome = "delivered";
      } else if (a.result === "retry") {
        queue.enqueue(event);
        outcome = "queued";
      } else {
        outcome = "dropped"; // terminal reject → do not re-queue
      }
      const drained = await drainQueue(token);
      const result: SendResult = { outcome, drained };
      if (a.status !== undefined) result.status = a.status;
      if (a.code !== undefined) result.code = a.code;
      return result;
    },

    async drainNow(): Promise<DrainResult> {
      const token = await getToken(config.tokenOptions);
      if (token === null) return EMPTY_DRAIN;
      return drainQueue(token);
    },
  };
}
