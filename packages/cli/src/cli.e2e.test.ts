/**
 * CLI-E2E — the mandatory CLI happy-path gate, driven through the real CLI commands in a
 * hermetic temp HOME against a stub backend: `login` (device flow / manual code) mints +
 * stores a token → `agent install all` writes managed config invoking the hook → a real
 * hook fire produces a canonical event observed at the stub's POST /v1/agent-events, carrying
 * the login-issued token as Bearer and with paths hashed. No mocks of the sender/normalizer —
 * the real code paths run; only the backend is the stub.
 *
 * DEFERRED (noted follow-up): the LIVE leg against the product `wrangler dev` (EVT-INGEST)
 * + the server-side push-job enqueue assertion — needs the product backend; stub-tested now.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  type AgentAdapter,
  createSender,
  getToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import {
  BIRDYBEEP_HOOK_COMMAND as CLAUDE_HOOK,
  claudeCodeAdapter,
  claudeSettingsPath,
} from "@birdybeep/claude-code";
import { codexAdapter } from "@birdybeep/codex";
import { opencodeAdapter } from "@birdybeep/opencode";
import {
  assertNoAbsolutePaths,
  assertPathsHashed,
  createSandbox,
  deliveredBearerToken,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./cli";
import { createAgentCommand } from "./commands/agent";
import { createHookCommand } from "./commands/hook";
import { createLoginCommand } from "./commands/login";
import { EXIT } from "./framework";

const MACHINE_TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };
const RAW_CWD = "/Users/dev/code/secret-project";

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
const ORIGINAL_CODEX_HOME = process.env["CODEX_HOME"];
beforeEach(() => delete process.env["CODEX_HOME"]);
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
});
afterAll(() => {
  if (ORIGINAL_CODEX_HOME !== undefined) process.env["CODEX_HOME"] = ORIGINAL_CODEX_HOME;
});

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}
function quiet(): {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
} {
  return { stdout: capture().writer, stderr: capture().writer };
}
function detected(adapter: AgentAdapter): AgentAdapter {
  return { ...adapter, detect: () => Promise.resolve({ detected: true, version: "test" }) };
}

/** Stub device-code pairing backend: /pair/start opens a session; /pair/token issues the token. */
function stubPairing(): typeof fetch {
  return ((url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/v1/pair/start")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "dc_e2e",
            user_code: "Z9-42",
            qr_payload: "https://birdybeep.com/pair?code=Z9-42",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          }),
          { status: 200 },
        ),
      );
    }
    // /v1/pair/token → 201 with the durable token.
    return Promise.resolve(
      new Response(JSON.stringify({ machine_token: MACHINE_TOKEN, machine_id: "mac_e2e" }), {
        status: 201,
      }),
    );
  }) as unknown as typeof fetch;
}

describe("CLI-E2E: login → install → hook → delivered", () => {
  it("runs the whole happy path through the real CLI commands (stub backend)", async () => {
    sink = await StubEventSink.start();
    const sinkUrl = sink.url;
    sandbox = createSandbox();
    const sb = sandbox;

    // 1. login (manual-code device flow) mints + stores the token in the temp HOME.
    const loginOk = await runCli(["login"], {
      commands: [
        createLoginCommand({
          fetchImpl: stubPairing(),
          tokenOptions: FILE_ONLY,
          sleep: () => Promise.resolve(),
        }),
      ],
      ...quiet(),
      ensureConfig: false,
    });
    expect(loginOk).toBe(EXIT.OK);
    expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN);

    // 2. agent install all writes managed config invoking the hook.
    const installOk = await runCli(["agent", "install", "all"], {
      commands: [
        createAgentCommand({
          adapters: [
            detected(claudeCodeAdapter),
            detected(codexAdapter),
            detected(opencodeAdapter),
          ],
        }),
      ],
      ...quiet(),
      ensureConfig: false,
    });
    expect(installOk).toBe(EXIT.OK);
    expect(readFileSync(claudeSettingsPath(sb.home), "utf8")).toContain(CLAUDE_HOOK);

    // 3. fire a real hook → the canonical event reaches POST /v1/agent-events.
    const out = capture();
    const payload = JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "sess-e2e",
      cwd: RAW_CWD,
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
    });
    const hookOk = await runCli(["hook", "claude", payload, "--json"], {
      commands: [
        createHookCommand({
          createSender: () => createSender({ baseUrl: sinkUrl, tokenOptions: FILE_ONLY }),
        }),
      ],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(hookOk).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "delivered" });

    // 4. the delivered event is canonical, authed with the login-issued token, paths hashed.
    expect(sink.received()).toHaveLength(1);
    const delivered = sink.received()[0]!;
    const body = delivered.body as { event_type: string; harness: string };
    expect(body.event_type).toBe("approval_required");
    expect(body.harness).toBe("claude_code");
    expect(deliveredBearerToken(delivered)).toBe(MACHINE_TOKEN); // token from login → used by hook
    assertPathsHashed(delivered, [RAW_CWD, sb.home, sb.realHome]);
    assertNoAbsolutePaths(delivered);
    // No token in the installed harness config.
    expect(readFileSync(claudeSettingsPath(sb.home), "utf8")).not.toContain(MACHINE_TOKEN);
  });
});
