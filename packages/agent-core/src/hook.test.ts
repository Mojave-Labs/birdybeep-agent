/**
 * Hook pipeline proof (unit): runAgentHook normalizes → dedups → sends; an unmappable
 * payload is skipped (no send); a duplicate beep is deduped (one send). Full
 * adapter↔sender↔sink integration is exercised by the Claude Code CC-E2E.
 */
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecentEventLedger } from "./dedup";
import { runAgentHook } from "./hook";
import type { AgentAdapter, BirdyBeepAgentEvent, BirdyBeepEventType } from "./index";
import type { Sender, SendResult } from "./sender";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
  vi.restoreAllMocks();
});

function evt(eventType: BirdyBeepEventType = "approval_required", body = "b"): BirdyBeepAgentEvent {
  return {
    event_id: "evt_1",
    event_type: eventType,
    occurred_at: "2026-06-14T00:00:00.000Z",
    harness: "claude_code",
    source_session_id: "s1",
    machine: { label: "box", os: "linux" },
    workspace: { cwd: "h_abc" },
    status: "waiting_for_approval",
    title: "t",
    body,
  };
}

/** Minimal adapter stub: only normalizeEvent matters to the hook pipeline. */
function adapterReturning(eventType: BirdyBeepEventType, body?: string): AgentAdapter {
  return {
    id: "claude_code",
    displayName: "stub",
    detect: () => Promise.resolve({ detected: true }),
    install: () =>
      Promise.resolve({
        changed: false,
        changedFiles: [],
        backupFiles: [],
        requiredActions: [],
        status: "installed",
      }),
    uninstall: () => Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] }),
    status: () => Promise.resolve("installed"),
    doctor: () => Promise.resolve({ ok: true, checks: [] }),
    normalizeEvent: () => Promise.resolve(evt(eventType, body)),
  };
}
const unmappableAdapter: AgentAdapter = {
  ...adapterReturning("approval_required"),
  normalizeEvent: () => Promise.reject(new Error("unmappable")),
};

function fakeSender(): Sender & { sent: BirdyBeepAgentEvent[] } {
  const sent: BirdyBeepAgentEvent[] = [];
  return {
    sent,
    send: (event): Promise<SendResult> => {
      sent.push(event);
      return Promise.resolve({ outcome: "delivered" });
    },
    drainNow: () => Promise.resolve({ delivered: 0, dropped: 0, kept: 0, pruned: 0 }),
  };
}

describe("runAgentHook", () => {
  it("normalizes and sends a mappable payload", async () => {
    sandbox = createSandbox();
    const sender = fakeSender();
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json") });
    const r = await runAgentHook(
      adapterReturning("approval_required"),
      { hook_event_name: "x" },
      { sender, ledger },
    );
    expect(r.outcome).toBe("delivered");
    expect(r.eventType).toBe("approval_required");
    expect(sender.sent).toHaveLength(1);
  });

  it("skips an unmappable payload without sending (never disturbs the harness)", async () => {
    sandbox = createSandbox();
    const sender = fakeSender();
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json") });
    const r = await runAgentHook(unmappableAdapter, { garbled: true }, { sender, ledger });
    expect(r.outcome).toBe("skipped");
    expect(sender.sent).toHaveLength(0);
  });

  it("dedupes a repeated beep — the same event fired twice sends once", async () => {
    sandbox = createSandbox();
    const sender = fakeSender();
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json") });
    const adapter = adapterReturning("approval_required");
    const first = await runAgentHook(adapter, {}, { sender, ledger });
    const second = await runAgentHook(adapter, {}, { sender, ledger });
    expect(first.outcome).toBe("delivered");
    expect(second.outcome).toBe("deduped");
    expect(sender.sent).toHaveLength(1); // no double-beep
  });

  it("sends BOTH when the same type carries different content (distinct beeps — erm)", async () => {
    sandbox = createSandbox();
    const sender = fakeSender();
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json") });
    const first = await runAgentHook(
      adapterReturning("needs_input", "Which file should I edit?"),
      {},
      { sender, ledger },
    );
    const second = await runAgentHook(
      adapterReturning("needs_input", "Which BRANCH should I use?"),
      {},
      { sender, ledger },
    );
    // The old type-only identity silently dropped the second, genuinely different beep.
    expect(first.outcome).toBe("delivered");
    expect(second.outcome).toBe("delivered");
    expect(sender.sent).toHaveLength(2);
  });

  it("collapses the permission double-fire (same approval, different payload shapes)", async () => {
    sandbox = createSandbox();
    const sender = fakeSender();
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json") });
    // One physical approval: Notification{permission_prompt} then PermissionRequest —
    // same session + type, DIFFERENT bodies, ~simultaneous. Exactly one beep.
    const first = await runAgentHook(
      adapterReturning("approval_required", "Claude Code needs your permission to use Bash"),
      {},
      { sender, ledger },
    );
    const second = await runAgentHook(
      adapterReturning("approval_required", "Approve Bash?"),
      {},
      { sender, ledger },
    );
    expect(first.outcome).toBe("delivered");
    expect(second.outcome).toBe("deduped");
    expect(sender.sent).toHaveLength(1);
  });

  it("beeps for a SECOND distinct approval once the short collapse window has passed", async () => {
    sandbox = createSandbox();
    const sender = fakeSender();
    let t = 1_000;
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json"), now: () => t });
    const first = await runAgentHook(
      adapterReturning("approval_required", "Approve Bash?"),
      {},
      { sender, ledger },
    );
    t += 1_500; // a NEW distinct approval arrives 1.5s later (inside the 10s content
    // window, past the 1s approval-collapse window) — it must beep. The window was
    // shrunk from 3s exactly so rapid-but-real second approvals like this aren't lost.
    const second = await runAgentHook(
      adapterReturning("approval_required", "Approve Edit?"),
      {},
      { sender, ledger },
    );
    expect(first.outcome).toBe("delivered");
    expect(second.outcome).toBe("delivered");
    expect(sender.sent).toHaveLength(2);
  });
});
