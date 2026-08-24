/**
 * birdybeep-agent-oi3 — the check that would have ended a multi-hour investigation in one command.
 *
 * `doctor` printed a full green board while the account's only device had been stale for five
 * weeks and every push landed on a dead registration. These pin the two ways that answer can be
 * wrong: claiming reachability that does not exist, and — just as important — manufacturing a
 * failure out of not knowing.
 */
import { describe, expect, it } from "vitest";

import { describeQuota, describeReachability, fetchPushReachability } from "./push-reachability";
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

  // birdybeep-2x9s: there is intentionally no staleness rule. last_seen_at never moves in
  // production (touch() has no caller), so failing on it would call an active account broken.
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
