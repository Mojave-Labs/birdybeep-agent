/**
 * birdybeep-agent-gcgp.23 E2E — a PAIRED machine whose token store will not answer must queue
 * its events and be told so, while a machine with genuinely no token keeps gcgp.4's
 * drop-and-warn. The two look identical to a `string | null` token read, and after gcgp.4 they
 * have opposite consequences, so they are proven side by side here.
 *
 * The machine is paired through the real `pair` command, its token lands in an injected
 * keychain backend (the real OS keychain is never touched — it is per-user, not per-HOME), and
 * that backend is then locked exactly the way macOS locks one: reads reject. Everything else is
 * the real thing — a real install in a hermetic temp HOME, a LIVE stub backend so the machine is
 * genuinely online throughout, and the real CLI dispatch → hook pipeline → sender → queue path.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import {
  type AgentAdapter,
  createSender,
  type KeychainBackend,
  LocalEventQueue,
  readUnpairedNotice,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import { claudeCodeAdapter } from "@birdybeep/claude-code";
import {
  createSandbox,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli";
import { createAgentCommand } from "./commands/agent";
import { createDoctorCommand } from "./commands/doctor";
import { createHookCommand } from "./commands/hook";
import { createPairCommand } from "./commands/pair";
import { createStatusCommand } from "./commands/status";
import { createTestCommand } from "./commands/test";
import { EXIT } from "./framework";

/** gcgp.4's control: no keychain at all and no token file → genuinely unpaired. */
const FILE_ONLY = { backend: unavailableKeychainBackend };
const MACHINE_TOKEN = `bbm_TESTONLY_${randomUUID()}`;
/** What macOS says when the login keychain is locked and nothing may prompt. */
const LOCKED_MESSAGE = "User interaction is not allowed.";

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

/**
 * A keychain backend that holds a real token and can be locked. `available: true` (so the store
 * genuinely prefers it), reads REJECT while locked — which is what a locked login keychain does,
 * and what the file fallback can never model since an empty file is an absence, not a failure.
 */
function lockableKeychain(): { backend: KeychainBackend; lock: () => void; unlock: () => void } {
  const store = new Map<string, string>();
  let locked = false;
  const key = (s: string, a: string) => `${s}:${a}`;
  return {
    lock: () => (locked = true),
    unlock: () => (locked = false),
    backend: {
      available: true,
      get: (s, a) =>
        locked
          ? Promise.reject(new Error(LOCKED_MESSAGE))
          : Promise.resolve(store.get(key(s, a)) ?? null),
      set: (s, a, secret) => {
        if (locked) return Promise.reject(new Error(LOCKED_MESSAGE));
        store.set(key(s, a), secret);
        return Promise.resolve();
      },
      delete: (s, a) => {
        store.delete(key(s, a));
        return Promise.resolve();
      },
    },
  };
}

const detectedClaude: AgentAdapter = {
  ...claudeCodeAdapter,
  detect: () => Promise.resolve({ detected: true, version: "test" }),
};

/** One turn of a real Claude Code session: a permission prompt, then a stop. */
function claudeSession(id: string, cwd: string): string[] {
  const base = { session_id: id, cwd, transcript_path: `${cwd}/t.jsonl` };
  return [
    JSON.stringify({ ...base, hook_event_name: "SessionStart", source: "startup" }),
    JSON.stringify({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash" }),
    JSON.stringify({ ...base, hook_event_name: "Stop" }),
  ];
}

/** Minimal device-code backend: `/pair/start` opens a session, `/pair/token` mints at once. */
function stubPairing(): typeof fetch {
  return ((url: string | URL) => {
    if (String(url).endsWith("/v1/pair/start")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "dc_test",
            user_code: "AB-1234",
            qr_payload: `https://birdybeep.com/pair#code=AB-1234&s=${"ab".repeat(32)}`,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ machine_token: MACHINE_TOKEN, machine_id: "mac_1" }), {
        status: 201,
      }),
    );
  }) as unknown as typeof fetch;
}

const CONFIRM_YES = {
  isStdinTTY: true,
  hasControllingTerminal: () => false,
  promptLine: () => Promise.resolve("y"),
};

describe("gcgp.23: a locked token store is not an unpaired machine", () => {
  it("queues a paired machine's events, names the real cause, and delivers them on unlock", async () => {
    sink = await StubEventSink.start(); // ONLINE for the whole test
    const sinkUrl = sink.url;
    sandbox = createSandbox();
    const keychain = lockableKeychain();
    const tokenOptions = { backend: keychain.backend, filePath: sandbox.path("data", "token") };

    // Pair for real, then install for real: this machine IS paired, and its token is in the
    // keychain — the arrangement gcgp.23 mis-reported the moment that keychain locked.
    expect(
      await runCli(["pair"], {
        commands: [
          createPairCommand({
            setup: false,
            fetchImpl: stubPairing(),
            tokenOptions,
            sleep: () => Promise.resolve(),
            ...CONFIRM_YES,
          }),
        ],
        stdout: capture().writer,
        stderr: capture().writer,
        ensureConfig: false,
      }),
    ).toBe(EXIT.OK);
    await runCli(["agent", "install", "claude"], {
      commands: [createAgentCommand({ adapters: [detectedClaude], tokenOptions })],
      stdout: capture().writer,
      stderr: capture().writer,
      ensureConfig: false,
    });

    keychain.lock(); // the screen locks mid-session

    const err = capture();
    for (const payload of claudeSession("sess-locked", sandbox.path("repo"))) {
      const code = await runCli(["hook", "claude"], {
        commands: [
          createHookCommand({
            createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions }),
            readStdin: () => Promise.resolve(payload),
          }),
        ],
        stdout: capture().writer,
        stderr: err.writer,
        ensureConfig: false,
      });
      expect(code).toBe(EXIT.OK); // a hook fire never errors the harness
    }

    // (1) THE ACCEPTANCE: the events are QUEUED, not dropped. Nothing reached the wire (there
    // was no token to send with), and nothing was thrown away.
    const queued = new LocalEventQueue().size();
    expect(queued).toBeGreaterThanOrEqual(2);
    expect(sink.received()).toHaveLength(0);
    // (2) …and the gcgp.4 sentinel was NOT written: nothing here was lost while unpaired.
    expect(readUnpairedNotice()).toBeNull();
    // (3) The hot path said what actually happened, and did NOT say "not paired".
    expect(err.text()).toContain("could not read the machine token");
    expect(err.text()).toContain("QUEUED");
    expect(err.text()).not.toContain("not paired");

    // (4) `status` reports the third state rather than a confident, wrong "no".
    const statusOut = capture();
    await runCli(["status"], {
      commands: [
        createStatusCommand({
          adapters: [],
          createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions }),
          tokenOptions,
        }),
      ],
      stdout: statusOut.writer,
      stderr: statusOut.writer,
      ensureConfig: false,
    });
    expect(statusOut.text()).toContain("Paired:  unknown");
    expect(statusOut.text()).toContain("QUEUED, not lost");
    expect(statusOut.text()).not.toContain("Paired:  no");

    // (5) …and so does `doctor`, whose remedy is to unlock the store, not to pair again.
    const doctorOut = capture();
    const doctorCode = await runCli(["doctor"], {
      commands: [
        createDoctorCommand({
          adapters: [],
          tokenOptions,
          createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions }),
          probeNetwork: () => Promise.resolve(true),
        }),
      ],
      stdout: doctorOut.writer,
      stderr: doctorOut.writer,
      ensureConfig: false,
    });
    expect(doctorCode).toBe(EXIT.ERROR);
    expect(doctorOut.text()).toContain("Could not read the token store");
    expect(doctorOut.text()).toContain(LOCKED_MESSAGE);
    expect(doctorOut.text()).toContain("Unlock your login keychain");
    expect(doctorOut.text()).not.toContain("No machine token found.");
    expect(doctorOut.text()).not.toContain("Events lost while unpaired");

    // (6) `test` — the command whose whole job is naming the cause — names this one too.
    const testOut = capture();
    await runCli(["test"], {
      commands: [
        createTestCommand({
          createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions }),
          tokenOptions,
        }),
      ],
      stdout: testOut.writer,
      stderr: testOut.writer,
      ensureConfig: false,
    });
    expect(testOut.text()).toContain("Could not read the machine token");
    expect(testOut.text()).not.toContain("Offline");
    expect(testOut.text()).not.toContain("NOT PAIRED");

    // (7) The payoff: unlock, and everything queued while locked is delivered. This is the whole
    // difference from a drop — the events were parked, and they arrive.
    keychain.unlock();
    await runCli(["status", "--json"], {
      commands: [
        createStatusCommand({
          adapters: [],
          createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions }),
          tokenOptions,
        }),
      ],
      stdout: capture().writer,
      stderr: capture().writer,
      ensureConfig: false,
    });
    expect(sink.received().length).toBeGreaterThanOrEqual(queued);
    expect(new LocalEventQueue().size()).toBe(0);
  });

  it("leaves gcgp.4 alone: with genuinely NO token, events are still dropped and recorded", async () => {
    sink = await StubEventSink.start();
    const sinkUrl = sink.url;
    sandbox = createSandbox();

    await runCli(["agent", "install", "claude"], {
      commands: [createAgentCommand({ adapters: [detectedClaude], tokenOptions: FILE_ONLY })],
      stdout: capture().writer,
      stderr: capture().writer,
      ensureConfig: false,
    });

    const err = capture();
    for (const payload of claudeSession("sess-unpaired", sandbox.path("repo"))) {
      await runCli(["hook", "claude"], {
        commands: [
          createHookCommand({
            createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
            readStdin: () => Promise.resolve(payload),
          }),
        ],
        stdout: capture().writer,
        stderr: err.writer,
        ensureConfig: false,
      });
    }

    // Unchanged from gcgp.4: dropped (never queued), recorded, and named as "not paired".
    expect(new LocalEventQueue().size()).toBe(0);
    expect(sink.received()).toHaveLength(0);
    expect(readUnpairedNotice()?.count).toBeGreaterThanOrEqual(2);
    expect(err.text()).toContain("not paired");
    expect(err.text()).not.toContain("could not read the machine token");

    const statusOut = capture();
    await runCli(["status"], {
      commands: [
        createStatusCommand({
          adapters: [],
          createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
          tokenOptions: FILE_ONLY,
        }),
      ],
      stdout: statusOut.writer,
      stderr: statusOut.writer,
      ensureConfig: false,
    });
    expect(statusOut.text()).toContain("Paired:  no — run `birdybeep pair`");
    expect(statusOut.text()).not.toContain("token store");
  });

  /**
   * The file-fallback machines (Linux, Windows, headless) have their own version of a locked
   * keychain: a token file that exists and will not read. Before gcgp.23 that threw out of the
   * sender and into the harness's hook.
   */
  it("treats an unreadable token FILE the same way — queued, never thrown into the harness", async () => {
    sink = await StubEventSink.start();
    const sinkUrl = sink.url;
    sandbox = createSandbox();
    // A directory where the token file belongs: it exists, and every read of it fails.
    const filePath = sandbox.path("data", "token-dir");
    const tokenOptions = { backend: unavailableKeychainBackend, filePath };
    mkdirSync(filePath, { recursive: true });

    const err = capture();
    const code = await runCli(["hook", "claude"], {
      commands: [
        createHookCommand({
          createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions }),
          readStdin: () =>
            Promise.resolve(claudeSession("sess-file", sandbox?.path("repo") ?? "/tmp")[1] ?? ""),
        }),
      ],
      stdout: capture().writer,
      stderr: err.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK); // never throws into the harness
    expect(new LocalEventQueue().size()).toBe(1);
    expect(readUnpairedNotice()).toBeNull();
    expect(err.text()).toContain("could not read the machine token");
  });
});
