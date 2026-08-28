/**
 * birdybeep-agent-oi3 — the check that would have ended a multi-hour investigation in one command.
 *
 * `doctor` printed a full green board while the account's only device had been stale for five
 * weeks and every push landed on a dead registration. These pin the two ways that answer can be
 * wrong: claiming reachability that does not exist, and — just as important — manufacturing a
 * failure out of not knowing.
 */
import { describe, expect, it } from "vitest";

import {
  describeCheckIn,
  describeQuota,
  describeReachability,
  fetchPushReachability,
} from "./push-reachability";
import { type KeychainBackend } from "./token-store";

const tokenBackend = (token: string | null): KeychainBackend => ({
  available: true,
  get: () => Promise.resolve(token),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
});

const body = (over: Partial<Record<string, unknown>> = {}) => ({
  active_device_count: 1,
  stale_device_count: 0,
  most_recent_registration_at: "2026-08-20T21:00:00.000Z",
  last_delivery: { status: "ok", at: "2026-08-20T21:30:00.000Z" },
  ...over,
});

const okFetch =
  (payload: unknown): typeof fetch =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

describe("fetchPushReachability", () => {
  const opts = (fetchImpl: typeof fetch, token: string | null = "mt_x") => ({
    baseUrl: "https://api.example.test",
    tokenOptions: { backend: tokenBackend(token), filePath: "/nonexistent/token" },
    fetchImpl,
  });

  it("reports `unpaired` with no token — the pairing row already says so", async () => {
    const res = await fetchPushReachability(opts(okFetch(body()), null));
    expect(res.state).toBe("unpaired");
  });

  it("returns the parsed payload", async () => {
    const res = await fetchPushReachability(opts(okFetch(body())));
    expect(res).toMatchObject({ state: "ok", data: { active_device_count: 1 } });
  });

  it("a non-2xx is `unavailable`, NOT zero devices", async () => {
    const f = (() => Promise.resolve(new Response("", { status: 500 }))) as unknown as typeof fetch;
    const res = await fetchPushReachability(opts(f));
    expect(res.state).toBe("unavailable");
  });

  it("an unrecognized shape is `unavailable` — contract drift must not read as 'no devices'", async () => {
    const res = await fetchPushReachability(opts(okFetch({ nope: true })));
    expect(res.state).toBe("unavailable");
  });

  it("a transport failure is `unavailable`", async () => {
    const f = (() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch;
    const res = await fetchPushReachability(opts(f));
    expect(res).toMatchObject({ state: "unavailable" });
  });
});

describe("describeReachability", () => {
  it("FAILS when no device can receive a beep — the green-board bug", () => {
    const out = describeReachability({
      state: "ok",
      data: body({ active_device_count: 0, most_recent_registration_at: null }),
    });
    expect(out?.ok).toBe(false);
    expect(out?.detail).toContain("No device can receive a beep");
    expect(out?.remedy).toContain("Open the BirdyBeep app");
  });

  it("names dead tokens when that is why the count is zero", () => {
    const out = describeReachability({
      state: "ok",
      data: body({ active_device_count: 0, stale_device_count: 2 }),
    });
    expect(out?.detail).toContain("dead push token");
  });

  // birdybeep-2x9s: this row still has no staleness rule of its own. most_recent_registration_at
  // never moves, so failing on it would call an active account broken; the real check-in is a
  // separate, non-failing row (describeCheckIn below).
  it("FAILS when Expo has confirmed the tokens are dead — a fact, not a timestamp", () => {
    const out = describeReachability({
      state: "ok",
      data: body({ active_device_count: 1, stale_device_count: 2 }),
    });
    expect(out?.ok).toBe(false);
    expect(out?.detail).toContain("dead push token");
    expect(out?.remedy).toContain("re-register");
  });

  it("does NOT fail an account merely because its registration timestamp is old", () => {
    const ancient = "2020-01-01T00:00:00.000Z";
    const out = describeReachability({
      state: "ok",
      data: body({ most_recent_registration_at: ancient }),
    });
    expect(out?.ok).toBe(true);
  });

  it("passes a healthy account and reports the last push outcome", () => {
    const out = describeReachability({ state: "ok", data: body() });
    expect(out?.ok).toBe(true);
    expect(out?.detail).toContain("last push ok");
  });

  it("does NOT manufacture a failure when it could not ask", () => {
    const out = describeReachability({ state: "unavailable", reason: "offline" });
    expect(out?.ok).toBe(true);
    expect(out?.detail).toContain("Could not check");
  });

  it("adds no row when unpaired — the machine-token check already failed", () => {
    expect(describeReachability({ state: "unpaired" })).toBeNull();
  });

  it("does not mention check-ins at all — that is a different question (2x9s)", () => {
    // The two rows must stay separable: this one answers "can a beep arrive", and folding an
    // activity signal into it is how a stale-looking timestamp turns into a false ✗.
    const out = describeReachability({
      state: "ok",
      data: body({ most_recent_check_in_at: "2020-01-01T00:00:00.000Z" }),
    });
    expect(out?.ok).toBe(true);
    expect(out?.detail).not.toContain("check");
  });
});

/**
 * birdybeep-agent-2x9s — the device check-in row.
 *
 * The check oi3 deliberately did NOT ship. A push APNs accepted, for a registration whose app had
 * been deleted, with every check green — and the obvious diagnostic was unavailable because the
 * only timestamp a device had was written at registration and never moved. A rule keyed on it
 * would have called a phone in daily use abandoned, so no rule shipped at all.
 *
 * A real heartbeat exists now, and these pin the properties that keep the restored row from
 * repeating that mistake: it never fails, it never turns an absence into a claim, and each of the
 * three "no timestamp" cases says which one it actually is.
 */
const CHECK_IN_NOW = new Date("2026-08-24T12:00:00.000Z");

describe("describeCheckIn (2x9s)", () => {
  it("reports a recent check-in as healthy, with the age and the day", () => {
    const out = describeCheckIn(
      { state: "ok", data: body({ most_recent_check_in_at: "2026-08-22T08:00:00.000Z" }) },
      CHECK_IN_NOW,
    );
    expect(out?.ok).toBe(true);
    expect(out?.detail).toContain("2 days ago");
    expect(out?.detail).toContain("2026-08-22");
  });

  it("says '0 days ago' for a check-in earlier today rather than rounding it away", () => {
    const out = describeCheckIn(
      { state: "ok", data: body({ most_recent_check_in_at: "2026-08-24T09:00:00.000Z" }) },
      CHECK_IN_NOW,
    );
    expect(out?.detail).toContain("0 days ago");
  });

  it("WARNS about a long-abandoned check-in — and still does not FAIL", () => {
    // The incident this row exists for: pushes accepted for a registration nobody is behind.
    // It must be visible, and it must not be a ✗ — `doctor`'s failures have to keep meaning
    // "no beep can arrive", and a phone in a drawer is not that.
    const out = describeCheckIn(
      { state: "ok", data: body({ most_recent_check_in_at: "2026-07-05T10:00:00.000Z" }) },
      CHECK_IN_NOW,
    );
    expect(out?.ok).toBe(true);
    expect(out?.detail).toContain("50 days");
    expect(out?.detail).toContain("2026-07-05");
    // …and the guidance lives in the DETAIL, because the renderer prints a remedy only for
    // failures (same reason as the near-limit quota row).
    expect(out?.detail).toContain("Open BirdyBeep on your phone");
  });

  it("does NOT claim beeps are still being delivered — it has read nothing that says so", () => {
    // The warning used to end "Beeps are still being sent". This row reads ONE field: a check-in
    // timestamp. The quota may be exhausted and the token may be dead — the two rows ABOVE it are
    // the ones that judge that — so asserting delivery here is the same class of confident wrong
    // answer the whole check was built to avoid, just pointed the reassuring way.
    const out = describeCheckIn(
      { state: "ok", data: body({ most_recent_check_in_at: "2026-07-05T10:00:00.000Z" }) },
      CHECK_IN_NOW,
    );
    expect(out?.detail).not.toContain("still being sent");
    expect(out?.detail).not.toMatch(/beeps are still/i);
    // It says what it does know (nobody opened the app), what that does not mean, and who does
    // answer the delivery question.
    expect(out?.detail).toContain("nobody has opened the app");
    expect(out?.detail).toContain("does not say a beep cannot arrive");
    expect(out?.detail).toContain("the rows above measure");
  });

  it("draws the warning line at 14 days and not a day earlier", () => {
    const at = (days: number) =>
      describeCheckIn(
        {
          state: "ok",
          data: body({
            most_recent_check_in_at: new Date(
              CHECK_IN_NOW.getTime() - days * 86_400_000,
            ).toISOString(),
          }),
        },
        CHECK_IN_NOW,
      )?.detail ?? "";
    expect(at(13)).toContain("last checked in 13 days ago");
    expect(at(13)).not.toContain("Open BirdyBeep on your phone");
    expect(at(14)).toContain("has checked in for 14 days");
  });

  it("NEVER claims staleness when no device has ever checked in — that is an app version, not a phone", () => {
    // The state of every account the day the backend ships this: the worker deploys weeks before
    // an App Store build lands. Reporting it as staleness is precisely the confident wrong answer
    // oi3 refused to ship.
    const out = describeCheckIn(
      { state: "ok", data: body({ most_recent_check_in_at: null }) },
      CHECK_IN_NOW,
    );
    expect(out?.ok).toBe(true);
    expect(out?.detail).toContain("has checked in yet");
    expect(out?.detail).toContain("newer version of the BirdyBeep app");
    expect(out?.detail).toContain("not a sign that anything is wrong");
  });

  it("names a server that does not report check-ins at all, instead of staying silent", () => {
    // Absent ≠ null. A silent row would read as "checked in fine" to anyone scanning the board.
    const out = describeCheckIn({ state: "ok", data: body() }, CHECK_IN_NOW);
    expect(out?.ok).toBe(true);
    expect(out?.detail).toContain("does not report device check-ins yet");
  });

  it("NAMES a future timestamp as clock skew, instead of clamping it to '0 days ago'", () => {
    // Intentional behaviour change (Codex review of PR #79): this used to assert the clamp, which
    // printed "0 days ago" beside a date that has not happened yet — a disagreement between two
    // clocks, rendered as a measurement. The row now says which it is and measures nothing.
    const out = describeCheckIn(
      { state: "ok", data: body({ most_recent_check_in_at: "2026-09-01T00:00:00.000Z" }) },
      CHECK_IN_NOW,
    );
    expect(out?.ok).toBe(true);
    expect(out?.detail).toContain("is in the future");
    expect(out?.detail).toContain("clock skew between this machine and the server");
    expect(out?.detail).toContain("2026-09-01T00:00:00.000Z");
    expect(out?.detail).not.toContain("days ago");
    // …and it is not smuggled in as staleness either: no warning, no remedy-in-detail.
    expect(out?.detail).not.toContain("Open BirdyBeep on your phone");
  });

  it("names skew for a timestamp only seconds ahead, rather than rounding it to today", () => {
    // The boundary that matters is `> now`, not "a day ahead": a one-second-future stamp is still
    // two clocks disagreeing, and clamping it is how the old wording produced its wrong answer.
    const out = describeCheckIn(
      {
        state: "ok",
        data: body({
          most_recent_check_in_at: new Date(CHECK_IN_NOW.getTime() + 1_000).toISOString(),
        }),
      },
      CHECK_IN_NOW,
    );
    expect(out?.ok).toBe(true);
    expect(out?.detail).toContain("is in the future");
    expect(out?.detail).not.toContain("0 days ago");
  });

  it("still measures a check-in stamped at exactly `now` rather than calling it skew", () => {
    const out = describeCheckIn(
      {
        state: "ok",
        data: body({ most_recent_check_in_at: CHECK_IN_NOW.toISOString() }),
      },
      CHECK_IN_NOW,
    );
    expect(out?.detail).toContain("0 days ago");
    expect(out?.detail).not.toContain("in the future");
  });

  it("says an unreadable timestamp is unreadable rather than old", () => {
    const out = describeCheckIn(
      { state: "ok", data: body({ most_recent_check_in_at: "not-a-date" }) },
      CHECK_IN_NOW,
    );
    expect(out?.ok).toBe(true);
    expect(out?.detail).toContain("unreadable check-in time");
  });

  it("adds NO row when the account has no active device — that row already failed", () => {
    expect(
      describeCheckIn(
        { state: "ok", data: body({ active_device_count: 0, most_recent_check_in_at: null }) },
        CHECK_IN_NOW,
      ),
    ).toBeNull();
  });

  it("adds NO row when the backend could not be asked, or the machine is unpaired", () => {
    expect(describeCheckIn({ state: "unavailable", reason: "offline" }, CHECK_IN_NOW)).toBeNull();
    expect(describeCheckIn({ state: "unpaired" }, CHECK_IN_NOW)).toBeNull();
  });
});

/**
 * birdybeep-agent-58l — the quota row.
 *
 * The failure it exists to end: the backend accepts an event (202) and rejects it afterwards at
 * the quota gate, so for a month every notifiable event on the owner's account was rejected while
 * this CLI reported delivery and `doctor` printed green. These pin the three ways that row could
 * itself be wrong — hiding a block, inventing one, or crashing on a server that predates it.
 */
const quota = (over: Partial<Record<string, unknown>> = {}) => ({
  plan: "free",
  period_start: "2026-08-01T00:00:00.000Z",
  period_end: "2026-09-01T00:00:00.000Z",
  beeps_accepted: 12,
  beeps_limit: 100,
  exhausted: false,
  ...over,
});

const NOW = new Date("2026-08-23T21:00:00.000Z");

describe("describeQuota (58l)", () => {
  it("FAILS when the quota is exhausted, and names the reset date", () => {
    const out = describeQuota(
      { state: "ok", data: body({ quota: quota({ beeps_accepted: 100, exhausted: true }) }) },
      NOW,
    );
    expect(out?.ok).toBe(false);
    expect(out?.detail).toContain("100/100 beeps");
    expect(out?.detail).toContain("EXHAUSTED");
    expect(out?.remedy).toContain("2026-09-01");
    expect(out?.remedy).toContain("Plus");
  });

  it("offers no upgrade to an account ALREADY on Plus — that limit is the ceiling", () => {
    // Backward compatibility with a backend deployed before Plus became unlimited.
    const out = describeQuota(
      {
        state: "ok",
        data: body({
          quota: quota({
            plan: "plus",
            beeps_accepted: 10000,
            beeps_limit: 10000,
            exhausted: true,
          }),
        }),
      },
      NOW,
    );
    expect(out?.ok).toBe(false);
    expect(out?.detail).toContain("10000/10000 beeps");
    expect(out?.remedy).toContain("resets on 2026-09-01");
    expect(out?.remedy).not.toContain("upgrade to Plus");
  });

  it("renders an unlimited Plus quota without a fake meter or reset", () => {
    const out = describeQuota({
      state: "ok",
      data: body({
        quota: quota({
          plan: "plus",
          beeps_accepted: 2480,
          beeps_limit: null,
          exhausted: false,
        }),
      }),
    });
    expect(out).toEqual({ ok: true, detail: "Unlimited beeps (plus plan)." });
  });

  it("shows BOTH window bounds, so a stuck window is visible on sight (the n9mn lesson)", () => {
    const out = describeQuota(
      { state: "ok", data: body({ quota: quota({ beeps_accepted: 7 }) }) },
      NOW,
    );
    expect(out?.detail).toContain("2026-08-01 → 2026-09-01");
  });

  it("a window that ALREADY ENDED is called out as a backend fault, not 'wait for the reset'", () => {
    // The owner's real row: a one-day trial window, still counting a month later. Telling that
    // user to wait for a reset that can never come is exactly how the month was lost.
    const out = describeQuota(
      {
        state: "ok",
        data: body({
          quota: quota({
            period_start: "2026-07-26T17:00:54.000Z",
            period_end: "2026-07-27T17:00:54.000Z",
            beeps_accepted: 100,
            exhausted: true,
          }),
        }),
      },
      NOW,
    );
    expect(out?.ok).toBe(false);
    expect(out?.detail).toContain("2026-07-26 → 2026-07-27");
    expect(out?.remedy).toContain("has not rolled over");
    expect(out?.remedy).not.toContain("upgrade to Plus");
  });

  it("passes while under the limit, and warns without failing when close to it", () => {
    const healthy = describeQuota({ state: "ok", data: body({ quota: quota() }) }, NOW);
    expect(healthy?.ok).toBe(true);
    expect(healthy?.detail).toBe("12/100 beeps used (free plan, period 2026-08-01 → 2026-09-01).");

    const nearly = describeQuota(
      { state: "ok", data: body({ quota: quota({ beeps_accepted: 95 }) }) },
      NOW,
    );
    expect(nearly?.ok).toBe(true); // 95/100 is not broken — do not manufacture a failure
    expect(nearly?.detail).toContain("only 5 left");
  });

  it("an OLDER server that does not report quota is informational, never a FAIL", () => {
    // A CLI outlives the backend it was built against. Hard-failing here would turn "one release
    // behind" into a fabricated outage in the command that is supposed to name the real one.
    const out = describeQuota({ state: "ok", data: body() }, NOW);
    expect(out?.ok).toBe(true);
    expect(out?.detail).toContain("does not report beep quota yet");
  });

  it("says nothing when unpaired or unreachable — the rows above already said it", () => {
    expect(describeQuota({ state: "unpaired" }, NOW)).toBeNull();
    expect(describeQuota({ state: "unavailable", reason: "offline" }, NOW)).toBeNull();
  });
});

describe("fetchPushReachability + quota parsing (58l)", () => {
  const opts = (fetchImpl: typeof fetch) => ({
    baseUrl: "https://api.example.test",
    tokenOptions: { backend: tokenBackend("mt_x"), filePath: "/nonexistent/token" },
    fetchImpl,
  });

  it("parses the quota block when present", async () => {
    const res = await fetchPushReachability(opts(okFetch(body({ quota: quota() }))));
    expect(res).toMatchObject({ state: "ok", data: { quota: { beeps_limit: 100 } } });
  });

  it("parses the nullable limit used for unlimited Plus", async () => {
    const res = await fetchPushReachability(
      opts(okFetch(body({ quota: quota({ plan: "plus", beeps_limit: null }) }))),
    );
    expect(res).toMatchObject({ state: "ok", data: { quota: { beeps_limit: null } } });
  });

  it("still parses a response with NO quota block (an older deployment)", async () => {
    const res = await fetchPushReachability(opts(okFetch(body())));
    expect(res.state).toBe("ok");
    expect(res.state === "ok" && res.data.quota).toBeUndefined();
  });

  it("a MALFORMED quota block is contract drift → unavailable, never a silent 'no quota'", async () => {
    // Dropping the bad block and rendering "server does not report quota" would be a confident
    // wrong answer, which is the whole failure mode this module exists to avoid.
    const res = await fetchPushReachability(
      opts(okFetch(body({ quota: quota({ beeps_limit: "lots" }) }))),
    );
    expect(res.state).toBe("unavailable");
  });
});
