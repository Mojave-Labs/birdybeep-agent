/**
 * Push reachability (birdybeep-agent-oi3) — the leg every other check leaves unasked.
 *
 * `doctor` verifies the MACHINE: token present, hooks installed, harness builds covered, backend
 * reachable. All of that can be green while the ACCOUNT cannot receive a beep at all. That is not
 * hypothetical: it printed a full green board for two hours while the owner's only device had
 * been stale for five weeks, so every push went to a dead registration — Expo ticket ok, receipt
 * ok, nothing on the phone. Nothing in the CLI could see that leg, because nothing exposed it.
 *
 * METADATA ONLY (§15.2): counts, timestamps, a delivery status. Never a token or notification
 * content — and the response is schema-validated here, so a backend that started returning more
 * than that would fail parsing rather than get printed.
 */
import { type PushReachabilityResponse, pushReachabilityResponseSchema } from "./api";
import { readToken, type TokenStoreOptions } from "./token-store";

const PATH = "/v1/machine/push-reachability";
/** Short: this runs inside `doctor`, which must stay responsive on a bad network. */
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * There is deliberately NO staleness check here (birdybeep-2x9s). The first draft failed an
 * account whose devices had not "checked in" for over a week — but devices.last_seen_at is only
 * ever written by register(); the touch() heartbeat has no production caller, so the value never
 * moves and an actively used account would have been reported as broken. Producing a confident
 * wrong answer is the exact failure this check exists to end, so it keys only on facts about
 * deliverability: no active device, or a token Expo has confirmed dead. Restore a staleness
 * check when a real heartbeat exists.
 */

export type ReachabilityResult =
  /** The backend answered. */
  | { readonly state: "ok"; readonly data: PushReachabilityResponse }
  /** No machine token — `doctor`'s own pairing check already says so; nothing to add. */
  | { readonly state: "unpaired" }
  /** Could not ask (offline, auth refused, unparseable). Never reported as "no devices". */
  | { readonly state: "unavailable"; readonly reason: string };

export interface PushReachabilityOptions {
  baseUrl: string;
  tokenOptions?: TokenStoreOptions;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Ask the backend whether this account has anywhere to deliver a beep. */
export async function fetchPushReachability(
  options: PushReachabilityOptions,
): Promise<ReachabilityResult> {
  const lookup = await readToken(options.tokenOptions ?? {});
  if (lookup.state === "absent") return { state: "unpaired" };
  if (lookup.state === "unavailable") return { state: "unavailable", reason: lookup.reason };

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}${PATH}`, {
      headers: { authorization: `Bearer ${lookup.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return { state: "unavailable", reason: `backend returned ${String(res.status)}` };
    const parsed = pushReachabilityResponseSchema.safeParse(await res.json());
    // A shape we do not recognize is a contract drift, not a device count. Saying "0 devices"
    // here would recreate the exact failure this check exists to end: a confident wrong answer.
    if (!parsed.success) return { state: "unavailable", reason: "unrecognized response" };
    return { state: "ok", data: parsed.data };
  } catch {
    return { state: "unavailable", reason: "could not reach the backend" };
  } finally {
    clearTimeout(timer);
  }
}

/** How `doctor` should render a reachability result: ok, plus the detail and any remedy. */
export function describeReachability(
  result: ReachabilityResult,
): { ok: boolean; detail: string; remedy?: string } | null {
  // `unpaired` adds nothing — the machine-token check above it already failed and said so.
  if (result.state === "unpaired") return null;
  if (result.state === "unavailable") {
    return {
      ok: true, // not knowing is not the same as being broken; do not manufacture a failure
      detail: `Could not check whether this account can receive a beep (${result.reason}).`,
    };
  }

  const {
    active_device_count: active,
    stale_device_count: stale,
    most_recent_registration_at: registeredAt,
  } = result.data;
  const last = result.data.last_delivery;
  const lastText = last ? `; last push ${last.status}` : "; no push sent yet";

  if (active === 0) {
    return {
      ok: false,
      detail:
        stale > 0
          ? `No device can receive a beep — ${String(stale)} registered device(s) have a dead push token.`
          : "No device can receive a beep — this account has no active device registered.",
      remedy:
        "Open the BirdyBeep app on your phone and sign in to register it. If it says the device " +
        "limit is full, free a slot in Settings › devices.",
    };
  }

  // Expo confirmed the token is dead. Unlike a timestamp, that is a fact about deliverability.
  if (stale > 0) {
    return {
      ok: false,
      detail: `${String(stale)} of this account's device(s) have a dead push token and cannot receive a beep.`,
      remedy: "Open the BirdyBeep app on those devices so they re-register.",
    };
  }

  return {
    ok: true,
    detail: `${String(active)} active device(s), registered ${String(registeredAt ?? "unknown")}${lastText}.`,
  };
}
