/**
 * `birdybeep report-status` proof (hermetic temp HOME, recording stub): each adapter's
 * pre-event status is POSTed to /v1/integrations/status with machine-token (Bearer) auth and
 * the correct harness + status value (incl. Codex `needs_trust`); an unreachable backend is
 * surfaced as "deferred" without hard-failing; and a not-logged-in run exits non-zero.
 * (Live post is a deferred follow-up.)
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
  body: unknown;
}
function recordingFetch(records: Recorded[]): typeof fetch {
  return ((url: string | URL, opts?: { headers?: Record<string, string>; body?: string }) => {
    records.push({
      url: String(url),
      auth: opts?.headers?.["authorization"],
      body: opts?.body ? (JSON.parse(opts.body) as unknown) : undefined,
    });
    return Promise.resolve(new Response("{}", { status: 200 }));
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
  it("POSTs each integration status with Bearer auth + the right harness/status", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const records: Recorded[] = [];
    const cmd = createReportStatusCommand({
      adapters: [
        adapter("claude_code", "installed"),
        adapter("codex", "needs_trust"),
        adapter("opencode", "needs_restart"),
      ],
      fetchImpl: recordingFetch(records),
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
    expect(records).toHaveLength(3);
    for (const r of records) {
      expect(r.url).toMatch(/\/v1\/integrations\/status$/);
      expect(r.auth).toBe(`Bearer ${TOKEN}`); // machine-token auth path
    }
    const byHarness = Object.fromEntries(
      records.map((r) => [(r.body as { harness: string }).harness, r.body as { status: string }]),
    );
    expect(byHarness["codex"]?.status).toBe("needs_trust"); // pre-event state reported
    expect(byHarness["opencode"]?.status).toBe("needs_restart");
    expect(byHarness["claude_code"]?.status).toBe("installed");

    const json = JSON.parse(out.text()) as { results: { reported: boolean }[] };
    expect(json.results.every((r) => r.reported)).toBe(true);
  });

  it("surfaces an unreachable backend as deferred without hard-failing", async () => {
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
    expect(code).toBe(EXIT.OK); // never blocks/fails install
    const json = JSON.parse(out.text()) as { results: { reported: boolean }[] };
    expect(json.results[0]?.reported).toBe(false); // deferred
  });

  it("exits non-zero when not logged in", async () => {
    sandbox = createSandbox();
    await clearToken(FILE_ONLY);
    const cmd = createReportStatusCommand({
      adapters: [adapter("codex", "needs_trust")],
      fetchImpl: recordingFetch([]),
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
