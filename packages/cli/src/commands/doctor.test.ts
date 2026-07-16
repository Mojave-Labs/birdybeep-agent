/**
 * `birdybeep doctor` proof (hermetic temp HOME): construct fault scenarios — no token, an
 * adapter reporting needs_trust / needs_restart / error, a non-empty queue, an unreachable
 * backend — and assert doctor detects each, prints the expected fix string, drains the
 * queue when reachable, mirrors findings under --json, and exits non-zero on any failure.
 * Doctor is read-only (it runs the adapters' read-only doctor()).
 */
import { randomUUID } from "node:crypto";

import {
  type AgentAdapter,
  clearToken,
  createSender,
  type DoctorResult,
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
import { createDoctorCommand } from "./doctor";
import { runHookCommand } from "./hook";

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

/** An adapter whose doctor() returns a fixed result (fault injection). */
function adapterWithDoctor(id: string, displayName: string, result: DoctorResult): AgentAdapter {
  return { id, displayName, doctor: () => Promise.resolve(result) } as AgentAdapter;
}

const codexUntrusted = adapterWithDoctor("codex", "Codex", {
  ok: false,
  checks: [
    {
      name: "Codex hooks trusted",
      ok: false,
      status: "needs_trust",
      remedy: "Open Codex and run /hooks",
    },
  ],
});
const opencodeNeedsRestart = adapterWithDoctor("opencode", "OpenCode", {
  ok: false,
  checks: [
    {
      name: "OpenCode plugin loaded",
      ok: false,
      status: "needs_restart",
      remedy: "Restart OpenCode",
    },
  ],
});

interface DoctorJson {
  ok: boolean;
  checks: { name: string; ok: boolean; remedy?: string }[];
  queue: { depthBefore: number; delivered: number; depthAfter: number };
}

describe("birdybeep doctor", () => {
  it("flags every fault with a fix, drains the queue, and exits non-zero (--json)", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    // Seed one queued event (failed earlier).
    const offline = createSender({
      baseUrl: "http://127.0.0.1:1",
      tokenOptions: FILE_ONLY,
      fetchImpl: () => Promise.reject(new Error("offline")),
    });
    await runHookCommand(
      "opencode",
      { type: "session.idle", properties: { sessionID: "s" }, cwd: "/tmp/x" },
      offline,
    );
    const sinkUrl = sink.url;

    const cmd = createDoctorCommand({
      adapters: [codexUntrusted, opencodeNeedsRestart],
      createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
      probeNetwork: () => Promise.resolve(false), // unreachable
    });
    const out = capture();
    const code = await runCli(["doctor", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.ERROR); // some checks failed
    const json = JSON.parse(out.text()) as DoctorJson;
    expect(json.ok).toBe(false);
    const byName = Object.fromEntries(json.checks.map((c) => [c.name, c]));
    expect(byName["Codex: Codex hooks trusted"]?.remedy).toMatch(/\/hooks/);
    expect(byName["OpenCode: OpenCode plugin loaded"]?.remedy).toMatch(/Restart OpenCode/);
    expect(byName["Backend reachable"]?.ok).toBe(false);
    // The queued event was drained to the (reachable) stub even though the probe said unreachable.
    expect(json.queue.depthBefore).toBe(1);
    expect(json.queue.delivered).toBe(1);
    expect(sink.received()).toHaveLength(1);
  });

  it("flags a missing token with the pair remedy", async () => {
    sandbox = createSandbox();
    await clearToken(FILE_ONLY);
    const cmd = createDoctorCommand({
      adapters: [],
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1", tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
      probeNetwork: () => Promise.resolve(true),
    });
    const out = capture();
    const code = await runCli(["doctor"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(out.text()).toMatch(/Machine token/);
    expect(out.text()).toMatch(/birdybeep pair/);
  });

  it("passes cleanly (exit 0) when token present, adapters healthy, backend reachable", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const healthy = adapterWithDoctor("claude_code", "Claude Code", {
      ok: true,
      checks: [{ name: "BirdyBeep hooks installed", ok: true }],
    });
    const cmd = createDoctorCommand({
      adapters: [healthy],
      createSender: () => createSender({ baseUrl: "http://127.0.0.1:1", tokenOptions: FILE_ONLY }),
      tokenOptions: FILE_ONLY,
      probeNetwork: () => Promise.resolve(true),
    });
    const out = capture();
    const code = await runCli(["doctor", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect((JSON.parse(out.text()) as DoctorJson).ok).toBe(true);
  });
});
