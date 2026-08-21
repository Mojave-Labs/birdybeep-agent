/**
 * birdybeep-agent-oi3 — the check that would have ended a multi-hour investigation in one command.
 *
 * `doctor` printed a full green board while the account's only device had been stale for five
 * weeks and every push landed on a dead registration. These pin the two ways that answer can be
 * wrong: claiming reachability that does not exist, and — just as important — manufacturing a
 * failure out of not knowing.
 */
import { describe, expect, it } from "vitest";

import { describeReachability, fetchPushReachability } from "./push-reachability";
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
