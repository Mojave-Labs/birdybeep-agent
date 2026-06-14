/**
 * `birdybeep test` proof (hermetic temp HOME): with the stub reachable, the command sends a
 * well-formed test event on the REAL sender path (cwd hashed by the normalizer) and reports
 * delivered; with the backend unreachable it queues the event, returns fast, and reports
 * queued. --json mirrors the outcome.
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
  it("is a valid custom event with the cwd hashed and a test marker", () => {
    const event = buildTestEvent({
      now: () => "2026-06-14T00:00:00.000Z",
      generateId: () => "evt_t",
    });
    expect(event.event_type).toBe("custom");
    expect(event.title).toBe("BirdyBeep test event");
    expect(event.metadata?.["test"]).toBe(true);
    expect(event.workspace.cwd).toMatch(/^h_[0-9a-f]{16}$/); // absolute cwd hashed
    expect(JSON.stringify(event)).not.toContain(process.cwd()); // no raw path
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
    expect(body.event_type).toBe("custom");
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
});
