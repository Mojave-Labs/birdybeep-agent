/**
 * `birdybeep report-status` proof (hermetic temp HOME): sends ONE batched
 * { integrations: [...] } POST to /v1/integrations/status with Bearer auth, surfaces the
 * server's EFFECTIVE per-harness status from the { integrations: [...] } response, treats a
 * 401/403 (mirrored error envelope) as TERMINAL (exit non-zero), and an unreachable backend
 * as deferred (exit 0, never blocks install). not-logged-in exits non-zero.
 */
import { randomUUID } from "node:crypto";

import {
  type AgentAdapter,
  clearToken,
  type IntegrationStatus,
  setToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { EXIT } from "../framework";
import { createReportStatusCommand } from "./report-status";

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

interface Recorded {
  url: string;
  auth: string | undefined;
  body:
    | {
        integrations?: {
          harness: string;
          status: string;
          harness_version?: string;
          adapter_version?: string;
        }[];
      }
    | undefined;
}
function recordingFetch(
  records: Recorded[],
  response: { status: number; body: unknown },
): typeof fetch {
  return ((url: string | URL, opts?: { headers?: Record<string, string>; body?: string }) => {
    records.push({
      url: String(url),
      auth: opts?.headers?.["authorization"],
      body: opts?.body ? (JSON.parse(opts.body) as Recorded["body"]) : undefined,
    });
    return Promise.resolve(
      new Response(JSON.stringify(response.body), { status: response.status }),
    );
  }) as unknown as typeof fetch;
}

function adapter(id: string, status: IntegrationStatus): AgentAdapter {
  return {
    id,
    displayName: id,
    detect: () => Promise.resolve({ detected: true, version: "1.0.0" }),
    status: () => Promise.resolve(status),
  } as AgentAdapter;
}

describe("birdybeep report-status", () => {
  it("sends ONE batched request with Bearer auth and surfaces the server's effective status", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const records: Recorded[] = [];
    // Server overrides codex → needs_trust regardless of what the CLI reported.
    const cmd = createReportStatusCommand({
      adapters: [adapter("claude_code", "installed"), adapter("codex", "installed")],
      fetchImpl: recordingFetch(records, {
        status: 200,
        body: {
          integrations: [
            { harness: "claude_code", status: "installed" },
            { harness: "codex", status: "needs_trust" },
          ],
        },
      }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    const code = await runCli(["report-status", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    // Exactly ONE batched POST (not one per harness).
    expect(records).toHaveLength(1);
    expect(records[0]?.url).toMatch(/\/v1\/integrations\/status$/);
    expect(records[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(records[0]?.body?.integrations?.map((i) => i.harness)).toEqual(["claude_code", "codex"]);
    // Each item carries harness_version (from detect) + adapter_version (the BirdyBeep adapter).
    expect(records[0]?.body?.integrations?.[0]?.harness_version).toBe("1.0.0");
    expect(records[0]?.body?.integrations?.[0]?.adapter_version).toBeDefined();

    const json = JSON.parse(out.text()) as {
      outcome: string;
      integrations: { harness: string; status: string }[];
    };
    expect(json.outcome).toBe("reported");
    // The EFFECTIVE (server) status is surfaced, not what we sent.
    const byHarness = Object.fromEntries(json.integrations.map((i) => [i.harness, i.status]));
    expect(byHarness["codex"]).toBe("needs_trust");
  });

  it("treats a 401/403 as terminal and exits non-zero", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const cmd = createReportStatusCommand({
      adapters: [adapter("codex", "needs_trust")],
      fetchImpl: recordingFetch([], {
        status: 403,
        body: { error: { code: "token_revoked", message: "revoked" } },
      }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    const code = await runCli(["report-status", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "terminal", error: "token_revoked" });
  });

  it("treats an unreachable backend as deferred without hard-failing (exit 0)", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const cmd = createReportStatusCommand({
      adapters: [adapter("codex", "needs_trust")],
      fetchImpl: () => Promise.reject(new Error("offline")),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    const code = await runCli(["report-status", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out.text())).toMatchObject({ outcome: "deferred" });
  });

  it("exits non-zero when not logged in", async () => {
    sandbox = createSandbox();
    await clearToken(FILE_ONLY);
    const cmd = createReportStatusCommand({
      adapters: [adapter("codex", "needs_trust")],
      fetchImpl: recordingFetch([], { status: 200, body: { integrations: [] } }),
      tokenOptions: FILE_ONLY,
    });
    const out = capture();
    const code = await runCli(["report-status"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(out.text()).toMatch(/Not logged in/);
  });
});
