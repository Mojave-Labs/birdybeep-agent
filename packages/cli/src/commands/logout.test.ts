/**
 * `birdybeep logout` / `birdybeep unpair` + `birdybeep queue clear` proof (hermetic temp
 * HOME): logout and its `unpair` twin both remove the machine token from the store
 * (idempotent), and queue clear empties the local queue and reports the count.
 */
import { randomUUID } from "node:crypto";

import {
  createSender,
  getToken,
  LocalEventQueue,
  setToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { EXIT } from "../framework";
import { runHookCommand } from "./hook";
import { createLogoutCommand, createUnpairCommand } from "./logout";
import { createQueueCommand } from "./queue";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}

describe("birdybeep logout", () => {
  it("removes the machine token and is idempotent", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    expect(await getToken(FILE_ONLY)).toBe(TOKEN);

    const cmd = createLogoutCommand({ tokenOptions: FILE_ONLY });
    const out = capture();
    const code = await runCli(["logout", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toEqual({ loggedOut: true });
    expect(await getToken(FILE_ONLY)).toBeNull(); // token gone

    // Idempotent: logging out again is fine.
    const code2 = await runCli(["logout"], {
      commands: [cmd],
      stdout: capture().writer,
      stderr: capture().writer,
      ensureConfig: false,
    });
    expect(code2).toBe(EXIT.OK);
  });
});

describe("birdybeep unpair", () => {
  it("is the token-clearing twin of logout (removes the token, idempotent)", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    expect(await getToken(FILE_ONLY)).toBe(TOKEN);

    const cmd = createUnpairCommand({ tokenOptions: FILE_ONLY });
    const out = capture();
    const code = await runCli(["unpair", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toEqual({ unpaired: true });
    expect(await getToken(FILE_ONLY)).toBeNull(); // token gone

    // Idempotent: unpairing again is fine.
    const code2 = await runCli(["unpair"], {
      commands: [cmd],
      stdout: capture().writer,
      stderr: capture().writer,
      ensureConfig: false,
    });
    expect(code2).toBe(EXIT.OK);
  });
});

describe("birdybeep queue clear", () => {
  it("empties the local queue and reports the count", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    // Seed 2 events into the queue (offline).
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
    await runHookCommand(
      "codex",
      { hook_event_name: "Stop", session_id: "s", cwd: "/tmp/x" },
      offline,
    );
    expect(new LocalEventQueue().size()).toBe(2);

    const out = capture();
    const code = await runCli(["queue", "clear", "--json"], {
      commands: [createQueueCommand()],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toEqual({ cleared: 2 });
    expect(new LocalEventQueue().size()).toBe(0); // emptied
  });
});
