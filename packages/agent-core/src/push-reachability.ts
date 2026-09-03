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
 * `describeReachability` still keys ONLY on facts about deliverability — no active device, or a
 * token Expo has confirmed dead. Its first draft failed an account whose devices had not "checked
 * in" for a week, reading `most_recent_registration_at`, which never moves; an actively used
 * account would have been reported as broken.
 *
 * The heartbeat that makes staleness answerable now exists (birdybeep-2x9s), and it is reported
 * SEPARATELY by {@link describeCheckIn} — on the new field only, and as a warning rather than a
 * failure. Keeping the two apart is deliberate: this function's answers are about whether a beep
 * CAN arrive, and a check-in is not one of those.
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
          ? `No device can receive a Beep: ${String(stale)} registered device(s) have a dead push token.`
          : "No active device can receive a Beep: this account has no registered device.",
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

// ── Device check-in (birdybeep-2x9s) ─────────────────────────────────────────────────────────
//
// The question `doctor` had to stop asking. The incident that started it: a push APNs accepted,
// for a registration whose app had long since been deleted — every check green, no beep anywhere.
// The obvious diagnostic ("when did a device last check in?") was unavailable, because
// `devices.last_seen_at` is written once at registration and never again, so the first attempt at
// this row would have called a phone in daily use stale. The check was dropped rather than shipped
// wrong (oi3).
//
// A real heartbeat exists now — the app stamps it on every foreground — so the row is back,
// keyed on that field and NOTHING else, with two rules that keep it honest:
//
//  1. It NEVER fails. A phone in a drawer for a month is not a broken account, and `doctor`'s ✗
//     is reserved for the states that mean no beep can arrive: no active device, a token Expo
//     confirmed dead, an exhausted quota. Making this the fourth would teach people to ignore the
//     other three. It warns, in the detail, which is where an `ok` row's guidance has to live
//     (the renderer prints a remedy only for failures — same as the near-limit quota row).
//  2. It never turns an ABSENCE into a claim. No check-in reported and no check-in recorded are
//     different facts, and both are different from "checked in long ago" — so each gets its own
//     sentence saying exactly which one it is.

/** Past this, a check-in is old enough to mention. Two weeks clears a holiday; a month is a phone
 *  nobody has opened. Deliberately generous: a false "abandoned" is worse than a late one. */
const STALE_CHECK_IN_DAYS = 14;
const DAY_MS = 86_400_000;

/** `2026-07-14T…` → `42 days` / `1 day`. Plain and copy-pasteable; no fuzzy "about a month". */
function daysAgoText(days: number): string {
  return `${String(days)} day${days === 1 ? "" : "s"}`;
}

/**
 * How `doctor` should render the device check-in row, or null when there is nothing honest to
 * say. `now` is injectable for deterministic tests.
 *
 * Null (no row at all) when: the backend could not be asked (the reachability row above already
 * reports that, with the reason — a second copy is noise), or the account has no active device
 * (that row already FAILED, and "nothing checked in" adds nothing to "there is nothing").
 */
export function describeCheckIn(
  result: ReachabilityResult,
  now: Date = new Date(),
): { ok: boolean; detail: string } | null {
  if (result.state !== "ok") return null;
  if (result.data.active_device_count === 0) return null;

  const checkedInAt = result.data.most_recent_check_in_at;

  if (checkedInAt === undefined) {
    // A backend deployed before 2x9s. Not a failure — an absence, named as one, so nobody reads
    // a silent row as "checked in fine".
    return {
      ok: true,
      detail: "Device check-ins are unavailable from this server.",
    };
  }

  if (checkedInAt === null) {
    // Devices exist and none has ever checked in. Overwhelmingly this is an app older than the
    // heartbeat, since the backend ships weeks ahead of the App Store — so it is reported as an
    // unknown, explicitly NOT as staleness. Guessing here is the exact mistake oi3 avoided.
    return {
      ok: true,
      detail:
        "No device check-in has been recorded. Check-ins may require a newer version of the " +
        "BirdyBeep app.",
    };
  }

  const at = Date.parse(checkedInAt);
  if (!Number.isFinite(at)) {
    // An unreadable timestamp is a backend oddity, not an old phone. Say which — and echo the
    // value BOUNDED, because it is server-supplied text on its way to a terminal.
    const shown = checkedInAt.length > 40 ? `${checkedInAt.slice(0, 40)}…` : checkedInAt;
    return {
      ok: true,
      detail: `This server reported an unreadable check-in time (${shown}), so device activity could not be checked.`,
    };
  }

  // Derived from the PARSED instant, not sliced off the raw string: the schema guarantees a
  // string, not an ISO one, so slicing a `Aug 20 2026`-shaped value would print nonsense.
  const day = new Date(at).toISOString().slice(0, 10);

  // A check-in the SERVER stamped can only sit ahead of this machine's clock if the two disagree,
  // so the row says that. It used to clamp the age to zero, which printed "0 days ago" beside a
  // date that has not happened yet — a smoothed-over disagreement reads as a measurement, and this
  // row's whole job is to stop looking like it measured something it did not. Not a failure and
  // not staleness: nothing about device activity is measurable from here until the clocks agree.
  if (at > now.getTime()) {
    return {
      ok: true,
      detail:
        `The latest check-in, ${new Date(at).toISOString()}, is ahead of this machine's clock. ` +
        "Check the system time on this machine and the server.",
    };
  }

  const days = Math.floor((now.getTime() - at) / DAY_MS);
  if (days < STALE_CHECK_IN_DAYS) {
    return { ok: true, detail: `A device last checked in ${daysAgoText(days)} ago (${day}).` };
  }

  // Says what a check-in IS evidence of — that nobody has opened the app — and nothing else. It
  // used to add "beeps are still being sent", which this row has read nothing to support: the
  // quota may be exhausted or the token dead, and those are exactly what the rows ABOVE judge.
  return {
    ok: true,
    detail: `No device has checked in since ${day}. Open BirdyBeep on a registered phone.`,
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

/** An exhausted quota is necessarily finite; unlimited Plus has no exhaustion/reset remedy. */
export type ExhaustedMachineQuota = MachineQuota & { readonly beeps_limit: number };

/** Narrow a wire quota before using finite-meter/reset copy. */
function hasFiniteBeepLimit(quota: MachineQuota): quota is ExhaustedMachineQuota {
  return quota.beeps_limit !== null;
}

/** `2026-08-01T00:00:00.000Z` → `2026-08-01`; anything unparseable is passed through verbatim. */
function isoDay(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : value;
}

/** `2026-08-01 → 2026-09-01` — BOTH bounds, always. A stuck window is only visible with both. */
function windowText(quota: MachineQuota): string {
  return `${isoDay(quota.period_start)} → ${isoDay(quota.period_end)}`;
}

/** Whether the backend is still reporting a billing period that should already have rolled. */
function hasStalledWindow(quota: MachineQuota, now: Date): boolean {
  const resetsAt = Date.parse(quota.period_end);
  return Number.isFinite(resetsAt) && resetsAt <= now.getTime();
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
  quota: ExhaustedMachineQuota,
  now: Date = new Date(),
): { window: string; remedy: string } {
  const resets = isoDay(quota.period_end);
  if (hasStalledWindow(quota, now)) {
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

  if (!hasFiniteBeepLimit(quota)) {
    return { ok: true, detail: `Unlimited beeps (${quota.plan} plan).` };
  }

  const used = `${String(quota.beeps_accepted)}/${String(quota.beeps_limit)} beeps`;
  const where = `${quota.plan} plan, period ${windowText(quota)}`;

  // gl9: a stale period is the same rollover fault whether or not this meter has reached zero.
  // Keep the row passing while the backend still reports allowance (beeps can flow), but name the
  // fault now instead of waiting for exhaustion to turn the first visible symptom into a FAIL.
  if (hasStalledWindow(quota, now) && !quota.exhausted) {
    const remaining = Math.max(0, quota.beeps_limit - quota.beeps_accepted);
    return {
      ok: true,
      detail:
        `${used} used (${where}) — WARNING: that period ended on ${isoDay(quota.period_end)} ` +
        `and the counter has not rolled over. The backend still reports ${String(remaining)} ` +
        "beep(s) available, so beeps can still flow, but the stalled window is a backend bug. " +
        "Report this with `birdybeep doctor --json`.",
    };
  }

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
