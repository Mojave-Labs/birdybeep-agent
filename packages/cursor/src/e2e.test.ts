/**
 * CUR-E2E — the mandatory real-hook gate. Installs the REAL Cursor adapter into a hermetic
 * temp HOME, then fires the ACTUAL captured Cursor hook payloads (`__fixtures__/sessionStart.json`,
 * `sessionEnd.json` — redacted real `cursor-agent 2026.07.09` output) through the
 * `birdybeep hook cursor` pipeline (runCursorHook = runAgentHook: normalizeEvent → dedup →
 * sender.send) and asserts, at the stub sink:
 *   - correct §10.1 mapping: sessionStart → session_started, sessionEnd{completed} → agent_completed;
 *   - the token resolves from the strict-perm FILE fallback (no keychain), rides as a Bearer, and
 *     never appears in the installed config or the event body;
 *   - absolute paths are hashed and nothing exceeds the cap;
 *   - PII IS DROPPED: neither `user_email` nor `transcript_path` (nor any raw path) appears
 *     ANYWHERE in the delivered event;
 *   - no trust/restart gate: status is `installed` right after install;
 *   - the hook returns fast (must not block the harness).
 * Stub sink only — live wrangler-dev / EVT-INGEST delivery is the deferred cross-repo E2E.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  createSender,
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
  type DeliveredEvent,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import sessionEndFixture from "./__fixtures__/sessionEnd.json";
import sessionStartFixture from "./__fixtures__/sessionStart.json";
import { cursorAdapter } from "./adapter";
import { runCursorHook } from "./hook";
import { cursorHooksPath } from "./paths";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };

// The redacted PII the captured fixtures carry — MUST NOT appear in any delivered event.
const FIXTURE_EMAIL = "user@example.com";
const FIXTURE_CWD = "/home/user/project";
const FIXTURE_TRANSCRIPT = (sessionEndFixture as { transcript_path: string }).transcript_path;
const FIXTURE_SESSION = (sessionStartFixture as { session_id: string }).session_id;

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
});

async function setUp(): Promise<{
  sb: Sandbox;
  fire: (p: unknown) => Promise<SendResult["outcome"] | "deduped" | "skipped">;
}> {
  sink = await StubEventSink.start();
  sandbox = createSandbox();
  const sb = sandbox;
  await setToken(TOKEN, FILE_ONLY); // strict-perm file fallback (keychain unavailable)
  const install = await cursorAdapter.install();
  expect(install.status).toBe("installed"); // Cursor: no trust/restart gate
  const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });
  const fire = async (p: unknown) => (await runCursorHook(p, { sender })).outcome;
  return { sb, fire };
}

function findByType(events: DeliveredEvent[], eventType: string): DeliveredEvent | undefined {
  return events.find((e) => (e.body as { event_type?: string }).event_type === eventType);
}

describe("CUR-E2E: install → fire the REAL captured fixtures → assert delivered", () => {
  it("maps sessionStart → session_started and sessionEnd(completed) → agent_completed", async () => {
    const { sb, fire } = await setUp();
    const start = Date.now();
    // The exact captured payloads — distinct event types → distinct dedup identities → both delivered.
    const startOutcome = await fire(sessionStartFixture);
    const endOutcome = await fire(sessionEndFixture);
    const elapsed = Date.now() - start;

    expect(startOutcome).toBe("delivered");
    expect(endOutcome).toBe("delivered");

    const expected: Record<string, string> = {
      session_started: "starting",
      agent_completed: "completed", // sessionEnd final_status === "completed"
    };
    expect(sink!.received()).toHaveLength(Object.keys(expected).length);

    for (const [eventType, status] of Object.entries(expected)) {
      const delivered = findByType(sink!.received(), eventType);
      expect(delivered, `missing ${eventType}`).toBeDefined();
      const body = delivered!.body as Record<string, unknown>;
      expect(body["status"]).toBe(status);
      expect(body["harness"]).toBe("cursor");
      expect(body["source_session_id"]).toBe(FIXTURE_SESSION);
      // Harness version carried through from cursor_version.
      expect(body["harness_version"]).toBe("2026.07.09-a3815c0");

      // Privacy: cwd hashed, no raw absolute paths, under cap, token never in the body.
      assertPathsHashed(delivered!, [FIXTURE_CWD, FIXTURE_TRANSCRIPT, sb.home, sb.realHome]);
      assertNoAbsolutePaths(delivered!);
      assertWithinSizeCap(delivered!);
      assertNoRawValues(delivered!, [TOKEN], { scope: "body" });
      // cwd IS hashed (not "unknown", not raw).
      const ws = body["workspace"] as Record<string, unknown>;
      expect(ws["cwd"]).toMatch(/^h_[0-9a-f]{16}$/);
      // Token came from the strict-perm FILE fallback and rode as a Bearer.
      expect(deliveredBearerToken(delivered!)).toBe(TOKEN);
    }

    // Hook returns fast (must not block the harness).
    expect(elapsed).toBeLessThan(5000);
    // No token in the installed Cursor config.
    expect(readFileSync(cursorHooksPath(sb.home), "utf8")).not.toContain(TOKEN);
  });

  it("DROPS PII: user_email + transcript_path (and any raw path) never leave the machine", async () => {
    const { fire } = await setUp();
    await fire(sessionStartFixture);
    await fire(sessionEndFixture);

    // Grep the full serialized delivered payload (body + headers) for the fixture's PII.
    const all = JSON.stringify(sink!.received());
    expect(all).not.toContain(FIXTURE_EMAIL); // user_email dropped
    expect(all).not.toContain(FIXTURE_TRANSCRIPT); // transcript_path dropped
    expect(all).not.toContain(".jsonl"); // no transcript path fragment survives
    expect(all).not.toContain(FIXTURE_CWD); // raw workspace root never leaves raw
    // And the strongest per-event catch-all: no absolute-path-shaped string in any body.
    for (const delivered of sink!.received()) assertNoAbsolutePaths(delivered);
  });

  it("status is installed immediately after install (no trust/restart gate)", async () => {
    await setUp();
    expect(await cursorAdapter.status()).toBe("installed");
  });

  it("an unmappable Cursor payload is skipped (never delivered, never throws)", async () => {
    const { fire } = await setUp();
    const outcome = await fire({
      hook_event_name: "beforeSubmitPrompt",
      session_id: FIXTURE_SESSION,
      workspace_roots: [FIXTURE_CWD],
    });
    expect(outcome).toBe("skipped");
    expect(sink!.received()).toHaveLength(0);
  });
});
