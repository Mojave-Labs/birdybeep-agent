/**
 * CX-TRUST proof (hermetic temp HOME): the Codex integration is held in needs_trust
 * after install (no event seen), and flips to "event seen" (→ installed, per
 * CX-STATUS-DOCTOR) ONLY when a real, mappable Codex event is processed through the
 * local hook. An unmappable/garbled payload is skipped and never grants trust. The
 * marker lives in the BirdyBeep data dir with strict perms and carries no content;
 * uninstall can clear it.
 */
import { randomUUID } from "node:crypto";

import { createSender, setToken, unavailableKeychainBackend } from "@birdybeep/agent-core";
import {
  createSandbox,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { installCodex } from "./install";
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

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
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

  it("a notify agent-turn-complete also grants trust", async () => {
    const { fire } = await setUp();
    const outcome = await fire({ type: "agent-turn-complete", "thread-id": "t1", cwd: CWD });
    expect(outcome).toBe("delivered");
    expect(hasCodexEventBeenSeen()).toBe(true);
  });

  it("an unmappable payload is skipped and never grants trust", async () => {
    const { fire } = await setUp();
    const outcome = await fire({ hook_event_name: "PreCompact", session_id: "s", cwd: CWD });
    expect(outcome).toBe("skipped");
    expect(sink!.received()).toHaveLength(0);
    expect(hasCodexEventBeenSeen()).toBe(false); // files-but-no-real-event must NOT flip
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
