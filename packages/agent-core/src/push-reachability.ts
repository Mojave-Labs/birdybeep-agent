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
import { pushReachabilityResponseSchema, type PushReachabilityResponse } from "./api";
import { readToken, type TokenStoreOptions } from "./token-store";

const PATH = "/v1/machine/push-reachability";
/** Short: this runs inside `doctor`, which must stay responsive on a bad network. */
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * A device that has not checked in for this long is reported as COLD. It is not proof of
 * breakage — a phone that simply has not opened the app looks the same — so it is a warning with
 * a remedy, not a hard failure. Five weeks was the real gap; a week is early enough to be useful
 * without crying wolf at someone back from holiday.
 */
export const STALE_SEEN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

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
  now: number,
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
    most_recent_seen_at,
  } = result.data;

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

  const seenMs = most_recent_seen_at ? Date.parse(most_recent_seen_at) : NaN;
  const cold = Number.isFinite(seenMs) && now - seenMs > STALE_SEEN_AFTER_MS;
  const last = result.data.last_delivery;
  const lastText = last ? `; last push ${last.status}` : "; no push sent yet";

  if (cold) {
    return {
      ok: false,
      detail:
        `${String(active)} active device(s), but none has checked in since ` +
        `${String(most_recent_seen_at)}${lastText}.`,
      remedy:
        "Open the BirdyBeep app on your phone so it re-registers. A device that stopped checking " +
        "in can still accept pushes that never appear.",
    };
  }

  return {
    ok: true,
    detail: `${String(active)} active device(s), last seen ${String(most_recent_seen_at ?? "unknown")}${lastText}.`,
  };
}
