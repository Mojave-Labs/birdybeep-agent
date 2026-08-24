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
import {
  type MachineQuota,
  type PushReachabilityResponse,
  pushReachabilityResponseSchema,
} from "./api";
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

// ── Beep quota (birdybeep-agent-58l) ─────────────────────────────────────────────────────────
//
// The second thing a green board could be hiding. The backend accepts an event with 202 and
// rejects it LATER, at the quota gate, so a quota-blocked account and a healthy one produced
// byte-identical output from this CLI — for a month, on the owner's account, while the product
// silently stopped doing the only thing it does.
//
// This renders the meter the backend reports; it never computes one. Everything printed comes
// from the response (the server derives it from the resolver the gate itself reads), so the row
// cannot disagree with the gate — and when the server does not report quota at all, the row says
// exactly that instead of guessing.

/** Fraction of the limit past which the row starts warning while still passing. */
const NEAR_LIMIT_FRACTION = 0.9;

/** `2026-08-01T00:00:00.000Z` → `2026-08-01`; anything unparseable is passed through verbatim. */
function isoDay(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : value;
}

/** `2026-08-01 → 2026-09-01` — BOTH bounds, always. A stuck window is only visible with both. */
function windowText(quota: MachineQuota): string {
  return `${isoDay(quota.period_start)} → ${isoDay(quota.period_end)}`;
}

/**
 * What an exhausted meter has to say: the window it is stuck in, and the one remedy that is
 * actually available. `doctor`'s quota row and `birdybeep test` both render it, so the two
 * commands cannot hand the same account contradictory advice about the same meter.
 *
 * Three cases, because only three are true:
 *   • `period_end` already in the past — the counter cannot roll over, so neither waiting nor
 *     paying fixes it. Name the backend fault (birdybeep-n9mn).
 *   • `plus` — that allowance is the ceiling, not a rung. Give the reset date and no upsell.
 *   • `free` — the reset date, and the upgrade that clears it sooner.
 *
 * `now` is injectable for deterministic tests.
 */
export function describeExhaustedQuota(
  quota: MachineQuota,
  now: Date = new Date(),
): { window: string; remedy: string } {
  const resetsAt = Date.parse(quota.period_end);
  const stuck = Number.isFinite(resetsAt) && resetsAt <= now.getTime();
  const resets = isoDay(quota.period_end);
  if (stuck) {
    return {
      window: windowText(quota),
      remedy:
        `That period ended on ${resets} and the counter has not rolled over — it should have. ` +
        "Report this with `birdybeep doctor --json`; it is a backend bug, not something you can " +
        "fix from here.",
    };
  }
  return {
    window: windowText(quota),
    remedy:
      quota.plan === "plus"
        ? `The quota resets on ${resets}. Plus is the largest beep allowance there is, so there ` +
          "is no higher plan to move to — beeps start arriving again then."
        : `The quota resets on ${resets}. To beep before then, upgrade to Plus in the BirdyBeep ` +
          "app (Settings › plan).",
  };
}

/**
 * How `doctor` should render the beep-quota row: exhausted is a FAILURE with a remedy naming the
 * reset date, everything else is informational. `now` is injectable for deterministic tests.
 *
 * Returns null when there is nothing honest to say — no token (the pairing row above already
 * failed), or the backend could not be asked (the reachability row above already reports that
 * failure, with the same reason; a second copy of it is noise, not information).
 */
export function describeQuota(
  result: ReachabilityResult,
  now: Date = new Date(),
): { ok: boolean; detail: string; remedy?: string } | null {
  if (result.state !== "ok") return null;

  const quota = result.data.quota;
  if (quota === undefined) {
    // A backend deployed before 58l. Not a failure — an absence, named as one.
    return {
      ok: true,
      detail:
        "This BirdyBeep server does not report beep quota yet, so a quota block would not show " +
        "up here. Check your usage in the app.",
    };
  }

  const used = `${String(quota.beeps_accepted)}/${String(quota.beeps_limit)} beeps`;
  const where = `${quota.plan} plan, period ${windowText(quota)}`;

  if (quota.exhausted) {
    return {
      ok: false,
      detail:
        `Beep quota EXHAUSTED — ${used} used (${where}). The backend is ACCEPTING your events ` +
        "and then rejecting every one of them, so no beep can arrive.",
      remedy: describeExhaustedQuota(quota, now).remedy,
    };
  }

  const remaining = quota.beeps_limit - quota.beeps_accepted;
  const near =
    quota.beeps_limit > 0 && quota.beeps_accepted >= quota.beeps_limit * NEAR_LIMIT_FRACTION;
  return {
    ok: true,
    detail: near
      ? `${used} used (${where}) — only ${String(remaining)} left before beeps stop; it resets on ${isoDay(quota.period_end)}.`
      : `${used} used (${where}).`,
  };
}
