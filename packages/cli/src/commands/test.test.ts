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
