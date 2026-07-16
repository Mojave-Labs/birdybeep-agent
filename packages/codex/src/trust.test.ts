/**
 * CX-TRUST proof (hermetic temp HOME): the Codex integration is held in needs_trust
 * after install (no event seen), and flips to "event seen" (→ installed, per
 * CX-STATUS-DOCTOR) ONLY when a real, TRUST-GATED LIFECYCLE HOOK event is processed
 * through the local hook. An unmappable/garbled payload is skipped and never grants
 * trust. The marker lives in the BirdyBeep data dir with strict perms and carries no
 * content; uninstall can clear it.
 *
 * birdybeep-agent-qyf (security): the `notify` program is NOT trust-gated — Codex runs
 * it regardless of whether the user ever approved the `[[hooks.*]]` entries via /hooks.
 * So a notify fire is NOT proof of trust and must NOT flip the marker; doing so let the
 * UI claim "installed"/"trusted" while the security-relevant PermissionRequest →
 * approval_required hook was still silently dropped. Only a hook_event_name-keyed
 * payload that actually reached delivery (delivered/queued) proves the trust-gated path
 * fired.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createSender,
  type DetectionResult,
  type Sender,
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

import { installCodex } from "./install";
import { codexStatus } from "./status";
import {
  clearCodexTrust,
  codexTrustMarkerIsStrict,
  hasCodexEventBeenSeen,
  recordCodexEventSeen,
  runCodexHook,
} from "./trust";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };
const CWD = "/Users/dev/code/codex-project";
const DETECTED: () => Promise<DetectionResult> = () => Promise.resolve({ detected: true });

/** The trust-gated lifecycle hook that carries the real approval signal (§9.6). */
const PERMISSION_REQUEST = {
  hook_event_name: "PermissionRequest",
  session_id: "sess-approval-1",
  cwd: CWD,
  tool_name: "Bash",
};
/** The top-level notify program — fires WITHOUT any /hooks trust. */
const NOTIFY_TURN_COMPLETE = { type: "agent-turn-complete", "thread-id": "t1", cwd: CWD };

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
let rejecting: Server | undefined;
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  if (rejecting) await new Promise<void>((r) => rejecting!.close(() => r()));
  sandbox = undefined;
  sink = undefined;
  rejecting = undefined;
});

async function setUp(): Promise<{ sb: Sandbox; fire: (p: unknown) => Promise<string> }> {
  sink = await StubEventSink.start();
  sandbox = createSandbox();
  const sb = sandbox;
  await setToken(TOKEN, FILE_ONLY);
  const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });
  const fire = async (p: unknown) => (await runCodexHook(p, { sender })).outcome;
  return { sb, fire };
}

/** A sender whose backend terminally rejects (401) → `dropped`. */
async function rejectingSender(): Promise<Sender> {
  rejecting = createServer((_req, res) => {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "unauthorized", message: "nope" } }));
  });
  await new Promise<void>((r) => rejecting!.listen(0, "127.0.0.1", () => r()));
  const { port } = rejecting.address() as AddressInfo;
  return createSender({ baseUrl: `http://127.0.0.1:${port}`, tokenOptions: FILE_ONLY });
}

describe("CX-TRUST: install → needs_trust → first real event flips it", () => {
  it("reports needs_trust on install and leaves no trust marker", async () => {
    sandbox = createSandbox();
    const install = await installCodex({}, sandbox.home);
    expect(install.status).toBe("needs_trust");
    expect(install.requiredActions.join(" ")).toMatch(/\/hooks/);
    // Files written, but no event seen yet → not trusted.
    expect(hasCodexEventBeenSeen()).toBe(false);
  });

  it("flips to event-seen ONLY after a real, mappable event is delivered", async () => {
    const { fire } = await setUp();
    expect(hasCodexEventBeenSeen()).toBe(false); // pre-trust

    const outcome = await fire({
      hook_event_name: "SessionStart",
      session_id: "sess-trust-1",
      cwd: CWD,
      source: "startup",
    });

    expect(outcome).toBe("delivered");
    expect(sink!.received()).toHaveLength(1);
    expect((sink!.received()[0]!.body as { event_type: string }).event_type).toBe(
      "session_started",
    );
    expect(hasCodexEventBeenSeen()).toBe(true); // post-trust
    expect(codexTrustMarkerIsStrict()).toBe(true); // strict perms (no group/other access)
  });

  // birdybeep-agent-qyf. This test previously asserted the OPPOSITE ("a notify
  // agent-turn-complete also grants trust") — it pinned the defect as if it were the
  // contract. notify is not trust-gated, so it proves nothing about /hooks trust.
  it("a notify agent-turn-complete is delivered but does NOT grant trust", async () => {
    const { fire } = await setUp();
    const outcome = await fire(NOTIFY_TURN_COMPLETE);

    expect(outcome).toBe("delivered"); // the beep itself still works…
    expect(sink!.received()).toHaveLength(1);
    expect(hasCodexEventBeenSeen()).toBe(false); // …but it is NOT proof the hooks are trusted
  });

  it("the trust-gated PermissionRequest hook grants trust", async () => {
    const { fire } = await setUp();
    const outcome = await fire(PERMISSION_REQUEST);

    expect(outcome).toBe("delivered");
    expect((sink!.received()[0]!.body as { event_type: string }).event_type).toBe(
      "approval_required",
    );
    expect(hasCodexEventBeenSeen()).toBe(true);
  });

  it("notify fires first (no trust), then a real hook flips it", async () => {
    const { fire } = await setUp();

    await fire(NOTIFY_TURN_COMPLETE);
    expect(hasCodexEventBeenSeen()).toBe(false); // still untrusted after the notify

    await fire(PERMISSION_REQUEST);
    expect(hasCodexEventBeenSeen()).toBe(true); // the trust-gated hook is the proof
  });

  it("a trust-gated hook that only QUEUES (unpaired) still proves trust", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    // No setToken → the sender cannot deliver and queues. The hook still FIRED, which is
    // what trust is about; delivery is a separate concern.
    const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });

    const result = await runCodexHook(PERMISSION_REQUEST, { sender });

    expect(result.outcome).toBe("queued");
    expect(hasCodexEventBeenSeen()).toBe(true);
  });

  it("a terminally-rejected (dropped) event does not grant trust", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const sender = await rejectingSender();

    const result = await runCodexHook(PERMISSION_REQUEST, { sender });

    expect(result.outcome).toBe("dropped");
    expect(hasCodexEventBeenSeen()).toBe(false);
  });

  it("an unmappable payload is skipped and never grants trust", async () => {
    const { fire } = await setUp();
    const outcome = await fire({ hook_event_name: "PreCompact", session_id: "s", cwd: CWD });
    expect(outcome).toBe("skipped");
    expect(sink!.received()).toHaveLength(0);
    expect(hasCodexEventBeenSeen()).toBe(false); // files-but-no-real-event must NOT flip
  });
});

/**
 * The user-visible symptom of birdybeep-agent-qyf: after install + a notify-only turn,
 * `birdybeep status` claimed Codex was "installed" (i.e. "approval beeps work") while the
 * PermissionRequest hook was still untrusted and silently dropped.
 */
describe("CX-TRUST: status must not claim installed until the hooks are really trusted", () => {
  it("notify-only leaves status at needs_trust; a real hook flips it to installed", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    const home = sandbox.home;
    await setToken(TOKEN, FILE_ONLY);
    const sender = createSender({ baseUrl: sink.url, tokenOptions: FILE_ONLY });

    await installCodex({}, home);
    expect(await codexStatus({ home, detect: DETECTED })).toBe("needs_trust");

    // A full agent turn happens. notify fires (it always does — no trust needed).
    expect((await runCodexHook(NOTIFY_TURN_COMPLETE, { sender })).outcome).toBe("delivered");
    expect(await codexStatus({ home, detect: DETECTED })).toBe("needs_trust"); // NOT "installed"

    // The user finally runs /hooks and trusts the entries → a lifecycle hook fires.
    expect((await runCodexHook(PERMISSION_REQUEST, { sender })).outcome).toBe("delivered");
    expect(await codexStatus({ home, detect: DETECTED })).toBe("installed");
  });
});

describe("CX-TRUST: marker primitives", () => {
  it("recordCodexEventSeen is idempotent and clearCodexTrust resets it", () => {
    sandbox = createSandbox();
    expect(hasCodexEventBeenSeen()).toBe(false);
    recordCodexEventSeen();
    recordCodexEventSeen(); // idempotent — no throw, still one marker
    expect(hasCodexEventBeenSeen()).toBe(true);
    expect(codexTrustMarkerIsStrict()).toBe(true);
    clearCodexTrust();
    expect(hasCodexEventBeenSeen()).toBe(false);
    clearCodexTrust(); // safe no-op when absent
  });
});
