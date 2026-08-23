/**
 * `birdybeep test` proof (hermetic temp HOME): with the stub reachable, the command sends a
 * well-formed test event on the REAL sender path (cwd hashed by the normalizer) and reports
 * delivered; with the backend unreachable it queues the event, returns fast, and reports
 * queued; with no machine token it says NOT PAIRED and queues nothing. --json mirrors the outcome.
 */
import { randomUUID } from "node:crypto";

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
    expect(event.title).toBe("BirdyBeep test event");
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
    expect(body.title).toBe("BirdyBeep test event");
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
    expect(out.text()).toContain("NO device on this account can receive it");
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
    expect(out.text()).toContain("queued for 2 registered device(s)");
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

  /**
   * birdybeep-agent-gcgp.4 REGRESSION. Observed verbatim on an unpaired but fully ONLINE
   * machine: "• Offline — test event queued; it will deliver when you reconnect.", exit 0.
   * Both halves were false — the machine was online, and nothing would ever deliver. `test` is
   * the ONE command whose whole job is diagnosis, so it has to name the real cause.
   */
  it("says NOT PAIRED — not 'Offline' — on an unpaired but ONLINE machine", async () => {
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

    expect(out.text()).toContain("NOT PAIRED");
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
    expect(text).toContain("Throttled by the backend (HTTP 429)");
    expect(text).toContain("test event queued");
    expect(text).toContain("Not your network");
    expect(code).toBe(EXIT.OK);
    expect(new LocalEventQueue().size()).toBe(1); // still parked for retry
  });

  it("says the BACKEND is having trouble on a 500 — not that you are offline", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const { text } = await runTest(backendSays(500, "internal_error"));
    expect(text).not.toContain("Offline");
    expect(text).toContain("backend");
    expect(text).toContain("HTTP 500");
  });

  it("still says Offline when the machine really cannot reach the backend", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const { text } = await runTest(() => Promise.reject(new TypeError("fetch failed")));
    expect(text).toContain("Offline");
    expect(new LocalEventQueue().size()).toBe(1);
  });

  it("keeps the terminal reject wording for a quota-exceeded 429 envelope", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const { code, text } = await runTest(backendSays(429, "quota_exceeded"));
    expect(text).toContain("rejected by the backend");
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
