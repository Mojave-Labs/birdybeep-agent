/**
 * `birdybeep login` proof (hermetic temp HOME, stub pairing server): the device flow shows
 * a pair URL + code, polls until paired, and stores the issued machine token in the SECURE
 * store — while the non-secret apiUrl goes to config and the token NEVER appears in config /
 * output. A pairing window that expires exits non-zero. (Live pairing is a deferred follow-up.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getToken, unavailableKeychainBackend } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { cliConfigPath } from "../config";
import { EXIT } from "../framework";
import { createLoginCommand } from "./login";

const MACHINE_TOKEN = `bbm_TESTONLY_${randomUUID()}`;
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

/** Stub pairing backend: `/v1/cli/pair` starts; `/v1/cli/pair/poll` is pending then paired. */
function stubPairing(opts: { alwaysPending?: boolean } = {}): typeof fetch {
  let polls = 0;
  return ((url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/v1/cli/pair")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            pair_url: "https://birdybeep.dev/p/ABCD",
            user_code: "ABCD-1234",
            poll_token: "pt_test",
            interval_ms: 1,
            expires_in_ms: 10_000,
          }),
          { status: 200 },
        ),
      );
    }
    if (u.endsWith("/v1/cli/pair/poll")) {
      polls += 1;
      if (opts.alwaysPending || polls < 2) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: "pending" }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "paired",
            machine_token: MACHINE_TOKEN,
            machine_label: "MacBook",
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as unknown as typeof fetch;
}

describe("birdybeep login", () => {
  it("pairs, stores the token securely, and never writes it to config", async () => {
    sandbox = createSandbox();
    const cmd = createLoginCommand({
      fetchImpl: stubPairing(),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(), // instant polls
    });
    const out = capture();
    const code = await runCli(["login"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    expect(out.text()).toContain("ABCD-1234"); // the manual code (and pair URL) are shown
    expect(out.text()).toContain("birdybeep.dev/p/ABCD");
    expect(out.text()).toMatch(/Paired/);

    // Durable token is in the secure store...
    expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN);
    // ...and NOT in the config file (which holds only the non-secret apiUrl).
    const config = readFileSync(cliConfigPath(), "utf8");
    expect(config).toContain("apiUrl");
    expect(config).not.toContain(MACHINE_TOKEN);
    // ...and never printed.
    expect(out.text()).not.toContain(MACHINE_TOKEN);
  });

  it("--json emits the paired result without the token", async () => {
    sandbox = createSandbox();
    const cmd = createLoginCommand({
      fetchImpl: stubPairing(),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
    });
    const out = capture();
    await runCli(["login", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    const json = JSON.parse(out.text()) as { paired: boolean; machineLabel?: string };
    expect(json).toMatchObject({ paired: true, machineLabel: "MacBook" });
    expect(out.text()).not.toContain(MACHINE_TOKEN);
  });

  it("exits non-zero when the pairing window expires without confirmation", async () => {
    sandbox = createSandbox();
    let t = 0;
    const cmd = createLoginCommand({
      fetchImpl: stubPairing({ alwaysPending: true }),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      now: () => {
        t += 6000; // each call advances 6s → crosses the 10s window after a couple polls
        return t;
      },
    });
    const out = capture();
    const code = await runCli(["login"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(out.text()).toMatch(/timed out/);
    expect(await getToken(FILE_ONLY)).toBeNull(); // no token stored on failure
  });
});
