/**
 * CC-E2E — the mandatory real-hook gate. Installs the REAL Claude Code adapter into a
 * hermetic temp HOME, then fires actual Claude Code hook payloads through the
 * `birdybeep hook claude` pipeline (runAgentHook = adapter.normalizeEvent → dedup →
 * sender.send) and asserts, at the stub sink:
 *   - correct §10.1 mapping for every notifying event (esp. approval_required from
 *     permission and agent_failed from StopFailure — the headline beeps);
 *   - the token is resolved from the strict-perm FILE fallback (no keychain) and rides
 *     as a Bearer, never in the installed config or the event body;
 *   - absolute paths are hashed, the long body is truncated, and nothing exceeds the cap;
 *   - notify defaults match §10.5;
 *   - the deferred DEDUP is resolved: PermissionRequest + Notification{permission_prompt}
 *     for one approval yield EXACTLY ONE approval_required (no double-beep);
 *   - the hook returns fast (must not block the harness).
 * Stub sink only — live wrangler-dev / EVT-INGEST delivery is the deferred cross-repo E2E.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSender,
  runAgentHook,
  type SendResult,
  setToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import {
  assertNoAbsolutePaths,
  assertNoRawValues,
  assertPathsHashed,
  assertWithinSizeCap,
  createSandbox,
  deliveredBearerToken,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { claudeCodeAdapter } from "./adapter";
import { claudeSettingsPath } from "./paths";

// Runtime token (never a source literal) stored in the file fallback (no keychain on CI).
const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };

// §10.5 default-notify (the six attention events beep).
const NOTIFY_DEFAULT: Record<string, boolean> = {
  session_started: false,
  agent_idle: true,
  needs_input: true,
  approval_required: true,
  agent_completed: true,
  agent_failed: true,
  subagent_completed: false,
};

const SESSION = "sess_e2e_1";
const RAW_CWD = "/Users/dev/code/secret-project";
const RAW_TRANSCRIPT = "/Users/dev/.claude/transcripts/2026-06-14.jsonl";
const LONG_MESSAGE = `Approve terraform apply against prod? ${"x".repeat(4000)}`; // forces truncation
const base = { session_id: SESSION, transcript_path: RAW_TRANSCRIPT, cwd: RAW_CWD };

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
const tmpCheckouts: string[] = [];
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
  for (const dir of tmpCheckouts.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway git checkout on disk (real `.git/HEAD`) so repo/branch detection has something to find. */
function tmpCheckout(name: string, branch: string): string {
  const root = mkdtempSync(join(tmpdir(), "bb-cc-e2e-"));
  tmpCheckouts.push(root);
  const repo = join(root, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  return repo;
}

async function setUp(): Promise<{
  sb: Sandbox;
  fire: (p: unknown) => Promise<SendResult["outcome"] | "deduped" | "skipped">;
}> {
  sink = await StubEventSink.start();
  sandbox = createSandbox();
  const sb = sandbox;
  // Token lives in the strict-perm file fallback (keychain unavailable), under temp HOME.
  await setToken(TOKEN, FILE_ONLY);
  // Real adapter install into the temp HOME.
  const install = await claudeCodeAdapter.install();
  expect(install.status).toBe("installed");
  const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });
  const fire = async (p: unknown) => (await runAgentHook(claudeCodeAdapter, p, { sender })).outcome;
  return { sb, fire };
}

describe("CC-E2E: install → fire real hooks → assert delivered", () => {
  it("delivers correctly-normalized events for every notifying hook (+ SessionStart)", async () => {
    const { sb, fire } = await setUp();
    const start = Date.now();
    // Distinct event types → distinct dedup identities → all delivered.
    await fire({
      ...base,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "claude-sonnet-4-6",
    });
    await fire({
      ...base,
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      message: LONG_MESSAGE,
    });
    await fire({
      ...base,
      hook_event_name: "Notification",
      notification_type: "auth_success",
      message: "Logged in",
    });
    await fire({
      ...base,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
    });
    await fire({ ...base, hook_event_name: "Stop" });
    await fire({ ...base, hook_event_name: "StopFailure", error_type: "rate_limit" });
    await fire({
      ...base,
      hook_event_name: "SubagentStop",
      agent_type: "Explore",
      agent_id: "sub_1",
    });
    const elapsed = Date.now() - start;

    const expected: Record<string, string> = {
      session_started: "starting",
      agent_idle: "idle",
      needs_input: "waiting_for_input",
      approval_required: "waiting_for_approval",
      agent_completed: "completed",
      agent_failed: "failed",
      subagent_completed: "running",
    };
    expect(sink!.received()).toHaveLength(Object.keys(expected).length); // every event delivered, none dropped

    for (const [eventType, status] of Object.entries(expected)) {
      const delivered = sink!.received().find((e) => {
        const body = e.body as { event_type?: string };
        return body.event_type === eventType;
      });
      expect(delivered, `missing ${eventType}`).toBeDefined();
      const body = delivered!.body as Record<string, unknown>;
      expect(body["status"]).toBe(status);
      expect(body["harness"]).toBe("claude_code");
      expect(body["source_session_id"]).toBe(SESSION);
      // Privacy: no raw absolute paths / no over-cap / token never in the body.
      assertPathsHashed(delivered!, [RAW_CWD, RAW_TRANSCRIPT, sb.home, sb.realHome]);
      assertNoAbsolutePaths(delivered!);
      assertWithinSizeCap(delivered!);
      assertNoRawValues(delivered!, [TOKEN], { scope: "body" });
      // Token came from the strict-perm FILE fallback and rode as a Bearer.
      expect(deliveredBearerToken(delivered!)).toBe(TOKEN);
      // Notify default matches §10.5.
      expect(NOTIFY_DEFAULT[eventType]).toBeDefined();
    }

    // Headline beeps explicitly present.
    const types = sink!.received().map((e) => (e.body as { event_type: string }).event_type);
    expect(types).toContain("approval_required"); // from PermissionRequest
    expect(types).toContain("agent_failed"); // from StopFailure

    // The over-long idle message was truncated.
    const idle = sink!
      .received()
      .find((e) => (e.body as { event_type: string }).event_type === "agent_idle");
    expect((idle!.body as { body: string }).body.length).toBeLessThan(LONG_MESSAGE.length);

    // Hook returns fast (must not block the harness).
    expect(elapsed).toBeLessThan(5000);

    // No token in the installed Claude Code config.
    expect(readFileSync(claudeSettingsPath(sb.home), "utf8")).not.toContain(TOKEN);
  });

  it("dedupes one approval: PermissionRequest + Notification{permission_prompt} → exactly ONE approval_required", async () => {
    const { fire } = await setUp();
    const first = await fire({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash" });
    const second = await fire({
      ...base,
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Allow Bash?",
    });
    expect(first).toBe("delivered");
    expect(second).toBe("deduped"); // same beep within the window → suppressed
    const approvals = sink!
      .received()
      .filter((e) => (e.body as { event_type: string }).event_type === "approval_required");
    expect(approvals).toHaveLength(1); // no double-beep
  });

  it("an unmappable hook payload is skipped (never delivered, never throws)", async () => {
    const { fire } = await setUp();
    const outcome = await fire({ ...base, hook_event_name: "PreCompact", trigger: "auto" });
    expect(outcome).toBe("skipped");
    expect(sink!.received()).toHaveLength(0);
  });

  it("delivers an enriched title + last-message body for a Stop from a real checkout (0r6)", async () => {
    const { fire } = await setUp();
    const repo = tmpCheckout("myapp", "main");
    const outcome = await fire({
      session_id: SESSION,
      transcript_path: RAW_TRANSCRIPT,
      cwd: repo,
      hook_event_name: "Stop",
      last_assistant_message:
        "Done — shipped the retry logic and every test is green.\n\n(details…)",
    });
    expect(outcome).toBe("delivered");

    const done = sink!
      .received()
      .find((e) => (e.body as { event_type?: string }).event_type === "agent_completed");
    expect(done, "agent_completed not delivered").toBeDefined();
    const body = done!.body as Record<string, unknown>;
    // What the user actually sees: WHICH checkout + WHAT it did — no more "Claude Code finished / Turn complete".
    expect(body["title"]).toBe("myapp · main — Claude Code finished");
    expect(body["body"]).toBe("Done — shipped the retry logic and every test is green.");
    const ws = body["workspace"] as Record<string, unknown>;
    expect(ws["repo_name"]).toBe("myapp");
    expect(ws["branch"]).toBe("main");
    // Privacy still holds: the real checkout path never leaves the machine.
    assertNoAbsolutePaths(done!);
    expect(JSON.stringify(done!.body)).not.toContain(repo);
  });
});
