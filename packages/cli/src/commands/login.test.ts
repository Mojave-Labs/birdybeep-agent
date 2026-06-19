/**
 * `birdybeep login` proof (hermetic temp HOME, stub device-code backend): POST /v1/pair/start
 * → show qr_payload + user_code → poll POST /v1/pair/token (validation_failed/4xx = pending)
 * until 201 {machine_token, machine_id}; store the token in the SECURE store, persist the
 * non-secret apiUrl, and NEVER write the token to config/output. An expired window exits
 * non-zero. Shapes are the product's canonical pairing contract.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getOS, getToken, unavailableKeychainBackend } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { cliConfigPath } from "../config";
import { EXIT } from "../framework";
import { CLI_VERSION } from "../version";
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

/** Stub device-code backend. `/pair/start` opens a session; `/pair/token` is 400 then 201. */
function stubPairing(
  opts: { expiresAt?: string; alwaysPending?: boolean; onStartBody?: (body: unknown) => void } = {},
): typeof fetch {
  let polls = 0;
  return ((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/v1/pair/start")) {
      // Capture the request body so tests can assert what the CLI actually sends (s0o7).
      if (opts.onStartBody) {
        opts.onStartBody(typeof init?.body === "string" ? JSON.parse(init.body) : init?.body);
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "dc_test",
            user_code: "AB-1234",
            qr_payload: "birdybeep://pair?code=AB-1234",
            expires_at: opts.expiresAt ?? new Date(Date.now() + 600_000).toISOString(),
          }),
          { status: 200 },
        ),
      );
    }
    // /v1/pair/token — validation_failed (400) while pending, then 201 with the token.
    polls += 1;
    if (opts.alwaysPending || polls < 2) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "validation_failed", message: "not yet approved" } }),
          { status: 400 },
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

describe("birdybeep login", () => {
  it("pairs via the device-code flow and stores the token securely (not in config)", async () => {
    sandbox = createSandbox();
    const cmd = createLoginCommand({
      fetchImpl: stubPairing(),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
    });
    const out = capture();
    const code = await runCli(["login"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    expect(out.text()).toContain("AB-1234"); // user code shown (manual path)
    expect(out.text()).toContain("birdybeep://pair?code=AB-1234"); // qr_payload shown
    expect(out.text()).toMatch(/Paired/);

    expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN); // token in the secure store
    const config = readFileSync(cliConfigPath(), "utf8");
    expect(config).toContain("apiUrl");
    expect(config).not.toContain(MACHINE_TOKEN); // never in config
    expect(out.text()).not.toContain(MACHINE_TOKEN); // never printed
  });

  it("sends machine_label + os + cli_version on POST /v1/pair/start (s0o7)", async () => {
    // The mobile approval sheet (06-pair-approve) shows the pending machine's name/OS/CLI
    // version BEFORE consent; the backend can only surface them if the CLI puts them in the
    // /pair/start body. Guards against a regression that drops these to null. The live
    // cross-repo proof lives in the product repo's xrepo-e2e (/v1/pair/inspect round-trip).
    sandbox = createSandbox();
    let startBody: Record<string, unknown> | undefined;
    const cmd = createLoginCommand({
      fetchImpl: stubPairing({ onStartBody: (b) => (startBody = b as Record<string, unknown>) }),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
    });
    const out = capture();
    const code = await runCli(["login"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    expect(startBody).toBeDefined();
    // Required label is always present; os + cli_version are the s0o7 additions.
    expect(typeof startBody?.machine_label).toBe("string");
    expect((startBody?.machine_label as string).length).toBeGreaterThan(0);
    expect(startBody?.os).toBe(getOS()); // normalized for THIS host (macos|windows|linux)
    expect(startBody?.cli_version).toBe(CLI_VERSION); // the @birdybeep/cli version marker
    // Neither field is null/undefined — the sheet would render "unknown" if so.
    expect(startBody?.os).not.toBeNull();
    expect(startBody?.cli_version).not.toBeNull();
  });

  it("--json emits the paired result + machine id, without the token", async () => {
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
    const json = JSON.parse(out.text()) as { paired: boolean; machineId?: string };
    expect(json).toMatchObject({ paired: true, machineId: "mac_1" });
    expect(out.text()).not.toContain(MACHINE_TOKEN);
  });

  it("exits non-zero when the pairing window expires without approval", async () => {
    sandbox = createSandbox();
    let t = 0;
    const cmd = createLoginCommand({
      // expires_at fixed at epoch 1,000,000 ms; the injected clock crosses it after one poll.
      fetchImpl: stubPairing({ expiresAt: new Date(1_000_000).toISOString(), alwaysPending: true }),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      now: () => {
        t += 600_000;
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
    expect(await getToken(FILE_ONLY)).toBeNull(); // no token on failure
  });
});
