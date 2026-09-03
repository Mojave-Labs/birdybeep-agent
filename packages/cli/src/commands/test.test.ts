/**
 * `birdybeep test` proof (hermetic temp HOME): with the stub reachable, the command sends a
 * well-formed test event on the REAL sender path (cwd hashed by the normalizer) and reports
 * delivered; with the backend unreachable it queues the event, returns fast, and reports
 * queued; with no machine token it says NOT PAIRED and queues nothing. --json mirrors the outcome.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import {
  createSender,
  LocalEventQueue,
  setToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import {
  createSandbox,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { EXIT } from "../framework";
import { buildTestEvent, createTestCommand } from "./test";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
});

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}

describe("buildTestEvent", () => {
  it("is a valid `test` event with the cwd hashed and a test marker (9fh)", () => {
    const event = buildTestEvent({
      now: () => "2026-06-14T00:00:00.000Z",
      generateId: () => "evt_t",
    });
    // "test" (not "custom"): the §10.5 matrix suppresses custom unconditionally, so a
    // custom-typed test could never produce the push it promises (9fh).
    expect(event.event_type).toBe("test");
    expect(event.title).toBe("BirdyBeep test");
    expect(event.metadata?.["test"]).toBe(true);
    expect(event.workspace.cwd).toMatch(/^h_[0-9a-f]{16}$/); // absolute cwd hashed
    expect(JSON.stringify(event)).not.toContain(process.cwd()); // no raw path
  });

  it("mints a UNIQUE session id per run so repeat tests don't collapse in dedupe (9fh)", () => {
    const a = buildTestEvent();
    const b = buildTestEvent();
    expect(a.source_session_id).toMatch(/^birdybeep-cli-test-/);
    expect(a.source_session_id).not.toBe(b.source_session_id);
  });
});

describe("birdybeep test", () => {
  it("delivers the test event on the real sender path (--json)", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    const cmd = createTestCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    const code = await runCli(["test", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "delivered" });
    expect(sink.received()).toHaveLength(1);
    const body = sink.received()[0]!.body as { event_type: string; title: string };
    expect(body.event_type).toBe("test");
    expect(body.title).toBe("BirdyBeep test");
  });

  // birdybeep-agent-oi3 — "delivered" means the BACKEND accepted the event and enqueued a push.
  // It says nothing about whether a device exists to receive one, and this line used to promise a
  // Beep on an account that had no reachable device at all. That promise is what made a genuinely
  // broken machine look fine for hours.
  it("does NOT promise a Beep when the account has no device that can receive it", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    sink.setReachability({
      active_device_count: 0,
      stale_device_count: 0,
      most_recent_registration_at: null,
      last_delivery: null,
    });
    const sinkUrl = sink.url;
    const cmd = createTestCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
      baseUrl: sinkUrl,
    });
    const out = capture();
    await runCli(["test"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(out.text()).toContain("No active device can receive a Beep");
    expect(out.text()).toContain("sign in to register it");
    expect(out.text()).not.toContain("check your phone for a test Beep");
  });

  it("reports the device count when the account IS reachable", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    sink.setReachability({
      active_device_count: 2,
      stale_device_count: 0,
      most_recent_registration_at: new Date().toISOString(),
      last_delivery: { status: "ok", at: new Date().toISOString() },
    });
    const sinkUrl = sink.url;
    const cmd = createTestCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
      baseUrl: sinkUrl,
    });
    const out = capture();
    await runCli(["test"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(out.text()).toContain("accepted for 2 registered device(s)");
  });

  it("queues + returns fast when offline, reporting queued", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const cmd = createTestCommand({
      createSender: () =>
        createSender({
          baseUrl: "http://127.0.0.1:1",
          tokenOptions: FILE_ONLY,
          fetchImpl: () => Promise.reject(new Error("offline")),
        }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    const start = Date.now();
    const code = await runCli(["test", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(Date.now() - start).toBeLessThan(5000); // fast even offline
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "queued" });
    expect(new LocalEventQueue().size()).toBe(1); // parked in the queue
  });

  it("does not promise a retry when the local queue cannot persist the event (9u0)", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const blocker = sandbox.path("blocked-data");
    writeFileSync(blocker, "a file where the queue parent directory should be");
    const queue = new LocalEventQueue({ dir: sandbox.path("blocked-data", "queue") });
    const cmd = createTestCommand({
      createSender: () =>
        createSender({
          baseUrl: "http://127.0.0.1:1",
          tokenOptions: FILE_ONLY,
          queue,
          fetchImpl: () => Promise.reject(new Error("offline")),
        }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();

    const code = await runCli(["test"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.ERROR);
    expect(out.text()).toContain("could not be sent or saved locally");
    expect(out.text()).not.toContain("it will deliver");
    expect(out.text()).not.toContain("retries on its own");
    expect(queue.size()).toBe(0);
  });

  /**
   * birdybeep-agent-gcgp.4 REGRESSION. Observed verbatim on an unpaired but fully ONLINE
   * machine: "• Offline — test event queued; it will deliver when you reconnect.", exit 0.
   * Both halves were false — the machine was online, and nothing would ever deliver. `test` is
   * the ONE command whose whole job is diagnosis, so it has to name the real cause.
   */
  it("says the machine is not paired instead of calling it offline", async () => {
    sink = await StubEventSink.start(); // the backend IS reachable
    sandbox = createSandbox();
    const sinkUrl = sink.url;
    // No setToken: unpaired. FILE_ONLY keeps the real OS keychain out of it.
    const cmd = createTestCommand({
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    const code = await runCli(["test"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(out.text()).toContain("This machine is not paired");
    expect(out.text()).toContain("birdybeep pair");
    expect(out.text()).not.toContain("Offline");
    expect(out.text()).not.toContain("test event queued"); // the exact false claim it used to make
    expect(code).toBe(EXIT.ERROR); // sent nothing → a failure, like `status`
    expect(new LocalEventQueue().size()).toBe(0); // nothing parked to flush on a first pair
    expect(sink.received()).toHaveLength(0);
  });

  it("mirrors the unpaired outcome in --json", async () => {
    sandbox = createSandbox();
    const cmd = createTestCommand({
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1", tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    const code = await runCli(["test", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "unpaired" });
    expect(code).toBe(EXIT.ERROR);
  });
});

/**
 * birdybeep-agent-0yk. `test` printed "Offline — test event queued; it will deliver when you
 * reconnect." for two states that are not offline: an event the SAME call went on to deliver
 * from the queue, and a backend that answered with a throttle or a 500. Both were observed on a
 * demonstrably online machine, and both send the user to debug their network.
 */
describe("birdybeep test — a queued outcome names the real cause (0yk)", () => {
  function backendSays(status: number, code: string): typeof fetch {
    return () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code, message: "not now" } }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
  }

  async function runTest(fetchImpl: typeof fetch, baseUrl = "http://127.0.0.1:1") {
    const cmd = createTestCommand({
      createSender: () => createSender({ baseUrl, tokenOptions: FILE_ONLY, fetchImpl }),
      tokenOptions: FILE_ONLY,
      baseUrl,
      fetchImpl,
    });
    const out = capture();
    const code = await runCli(["test"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    return { code, text: out.text() };
  }

  it("says the backend is THROTTLING — not that you are offline", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const { code, text } = await runTest(backendSays(429, "rate_limited"));
    expect(text).not.toContain("Offline");
    expect(text).not.toContain("when you reconnect");
    expect(text).toContain("Backend returned HTTP 429");
    expect(text).toContain("test event is queued");
    expect(code).toBe(EXIT.OK);
    expect(new LocalEventQueue().size()).toBe(1); // still parked for retry
  });

  it("says the BACKEND is having trouble on a 500 — not that you are offline", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const { text } = await runTest(backendSays(500, "internal_error"));
    expect(text).not.toContain("Offline");
    expect(text).toContain("Backend");
    expect(text).toContain("HTTP 500");
  });

  it("says the backend could not be reached when the network request fails", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const { text } = await runTest(() => Promise.reject(new TypeError("fetch failed")));
    expect(text).toContain("Could not reach the backend");
    expect(new LocalEventQueue().size()).toBe(1);
  });

  it("keeps a quota-exceeded 429 terminal — never queued, and it names the quota (58l)", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const { code, text } = await runTest(backendSays(429, "quota_exceeded"));
    expect(text).toContain("monthly beep quota is used up");
    expect(code).toBe(EXIT.ERROR);
    expect(new LocalEventQueue().size()).toBe(0); // terminal → never re-queued
  });

  it("reports DELIVERED when a blip queued the event and the same call's drain sent it", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sinkUrl = sink.url;
    let blipped = false;
    // One transient failure on the ingest POST, then the real stub — the exact shape of the
    // owner-observed run: fetch attempts 2, queue empty, and the CLI still said "Offline".
    const blip: typeof fetch = (url, init) => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (!blipped && target.includes("/v1/agent-events")) {
        blipped = true;
        return Promise.reject(new Error("ECONNRESET"));
      }
      return fetch(url, init);
    };

    const cmd = createTestCommand({
      createSender: () =>
        createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY, fetchImpl: blip }),
      tokenOptions: FILE_ONLY,
      baseUrl: sinkUrl,
    });
    const out = capture();
    const code = await runCli(["test"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(out.text()).not.toContain("Offline");
    expect(out.text()).toContain("accepted");
    expect(code).toBe(EXIT.OK);
    expect(sink.received()).toHaveLength(1); // it really did arrive
    expect(new LocalEventQueue().size()).toBe(0); // and nothing is left waiting
  });

  it("mirrors the queue cause in --json", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const cmd = createTestCommand({
      createSender: () =>
        createSender({
          baseUrl: "http://127.0.0.1:1",
          tokenOptions: FILE_ONLY,
          fetchImpl: backendSays(503, "internal_error"),
        }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    await runCli(["test", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "queued", queueCause: "backend" });
  });
});

/**
 * A quota rejection, named (birdybeep-agent-58l).
 *
 * `birdybeep test` printed "rejected by the backend" — true, and useless: it names neither the
 * cause nor anything to do about it, on the one command whose entire job is to say why beeps are
 * not arriving. The 429 envelope carries `quota_exceeded`, and the reachability read carries the
 * account's meter, so the real sentence is available for free. Nothing here is invented: with an
 * older backend that reports no quota, the copy stops at what the error code proves.
 */
describe("birdybeep test: quota rejection copy (58l)", () => {
  // Dates are relative to the run, not literals: the copy branches on whether `period_end` is
  // still ahead, so a hard-coded "2026-09-01" would silently start exercising the stuck-window
  // branch once that date passed, and this suite would fail for a reason no one changed.
  const DAY_MS = 86_400_000;
  const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString();
  const day = (offsetDays: number) => iso(offsetDays).slice(0, 10);
  const OPEN_START = iso(-10);
  const OPEN_END = iso(20);

  const QUOTA = {
    plan: "free",
    period_start: OPEN_START,
    period_end: OPEN_END,
    beeps_accepted: 100,
    beeps_limit: 100,
    exhausted: true,
  };

  /** 429 quota_exceeded on the send; the reachability read answers with `payload`. */
  function quotaFetch(payload: unknown): typeof fetch {
    return ((url: string) => {
      const href = String(url);
      if (href.includes("/v1/agent-events")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "quota_exceeded", message: "monthly beep limit reached" },
            }),
            { status: 429, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (href.includes("/v1/machine/push-reachability")) {
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch ${href}`));
    }) as unknown as typeof fetch;
  }

  const reachable = {
    active_device_count: 1,
    stale_device_count: 0,
    most_recent_registration_at: "2026-08-20T21:00:00.000Z",
    last_delivery: { status: "ok", at: "2026-08-20T21:30:00.000Z" },
  };

  async function runTest(payload: unknown): Promise<string> {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const fetchImpl = quotaFetch(payload);
    const cmd = createTestCommand({
      createSender: () =>
        createSender({ baseUrl: "https://api.test", tokenOptions: FILE_ONLY, fetchImpl }),
      tokenOptions: FILE_ONLY,
      baseUrl: "https://api.test",
      fetchImpl,
    });
    const out = capture();
    await runCli(["test"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    return out.text();
  }

  it("names the quota, the window and the reset date instead of 'rejected by the backend'", async () => {
    const text = await runTest({ ...reachable, quota: QUOTA });
    expect(text).toContain("monthly beep quota is used up");
    expect(text).toContain("100/100 beeps");
    expect(text).toContain(`${day(-10)} → ${day(20)}`);
    expect(text).toContain(`resets on ${day(20)}`);
    expect(text).toContain("upgrade to Plus");
    expect(text).not.toContain("rejected by the backend.");
  });

  it("does NOT sell Plus to an account already ON Plus — that plan's limit is the ceiling", async () => {
    // `{plan: "plus", exhausted: true}` is a real wire state (the Plus allowance is a hard cap,
    // not a rung), and "upgrade to Plus in the app" is an impossible instruction for that user.
    const text = await runTest({ ...reachable, quota: { ...QUOTA, plan: "plus" } });
    expect(text).toContain("monthly beep quota is used up");
    expect(text).toContain("plus plan");
    expect(text).toContain(`resets on ${day(20)}`);
    expect(text).not.toContain("upgrade to Plus");
  });

  it("handles an upgrade race without printing a null meter or reset advice", async () => {
    const text = await runTest({
      ...reachable,
      quota: {
        ...QUOTA,
        plan: "plus",
        beeps_accepted: 100,
        beeps_limit: null,
        exhausted: false,
      },
    });
    expect(text).toContain("now reports unlimited beeps on Plus");
    expect(text).toContain("plan changed between those requests");
    expect(text).toContain("run `birdybeep test` again");
    expect(text).not.toContain("100/null");
    expect(text).not.toContain("resets on");
  });

  it("a period that ALREADY ENDED is named as a backend fault, not a reset to wait for", async () => {
    // The n9mn signature, and the reason this ticket exists: the meter cannot roll over, so both
    // "wait until it resets" and "upgrade" are advice that can never work. `doctor` already said
    // so; `test` reads the same block through the same function and must not disagree.
    const text = await runTest({
      ...reachable,
      quota: { ...QUOTA, period_start: iso(-40), period_end: iso(-30) },
    });
    expect(text).toContain(`${day(-40)} → ${day(-30)}`);
    expect(text).toContain("has not rolled over");
    expect(text).not.toContain("resets on");
    expect(text).not.toContain("upgrade to Plus");
  });

  it("still names the CAUSE when the server reports no quota — but invents no dates", async () => {
    // The old copy sent this user to `birdybeep doctor`, which reads THIS response: on this
    // server it renders "does not report beep quota yet" and has no date either. Point at the
    // one place that does know.
    const text = await runTest(reachable);
    expect(text).toContain("monthly beep quota is used up");
    expect(text).toContain("check your usage in the BirdyBeep app");
    expect(text).not.toContain("resets on");
    expect(text).not.toContain("birdybeep doctor");
  });
});
