/**
 * Hook pipeline proof (unit): runAgentHook normalizes → filters → dedups → sends; an
 * unmappable payload is skipped (no send); a `local_only` type is filtered (no send, but
 * counted); a duplicate beep is deduped (one send). Full adapter↔sender↔sink integration
 * is exercised by the Claude Code CC-E2E.
 */
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecentEventLedger } from "./dedup";
import { readFilteredActivity } from "./filtered-activity";
import { runAgentHook } from "./hook";
import type { AgentAdapter, BirdyBeepAgentEvent, BirdyBeepEventType } from "./index";
import { BIRDYBEEP_EVENT_TYPES, DEFAULT_NOTIFY, LOCAL_ONLY_EVENT_TYPES } from "./index";
import { readObservedBuilds } from "./observed-builds";
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

  // ── gcgp.3: the client-side event-type filter ──────────────────────────────────────────
  it("FILTERS tool_finished — the 88.5% — before the ledger and the sender ever see it", async () => {
    sandbox = createSandbox();
    const sender = fakeSender();
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json") });
    const path = sandbox.path("data", "filtered.json");
    const r = await runAgentHook(
      adapterReturning("tool_finished"),
      { hook_event_name: "PostToolUse" },
      { sender, ledger, filteredActivity: { path } },
    );
    expect(r.outcome).toBe("filtered");
    expect(r.eventType).toBe("tool_finished");
    expect(sender.sent).toHaveLength(0); // nothing left the machine
    expect(readFilteredActivity({ path })).toMatchObject({
      count: 1,
      byType: { tool_finished: 1 },
    });
  });

  it("keeps counting a repeat instead of deduping it away (status must show activity)", async () => {
    sandbox = createSandbox();
    const sender = fakeSender();
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json") });
    const path = sandbox.path("data", "filtered.json");
    const adapter = adapterReturning("tool_finished");
    for (let i = 0; i < 3; i += 1) {
      const r = await runAgentHook(adapter, {}, { sender, ledger, filteredActivity: { path } });
      expect(r.outcome).toBe("filtered"); // never "deduped" — the filter runs first
    }
    expect(sender.sent).toHaveLength(0);
    expect(readFilteredActivity({ path })?.count).toBe(3);
  });

  it("still DELIVERS every notifiable type, and still sends the non-notifying types the worker needs", async () => {
    for (const type of BIRDYBEEP_EVENT_TYPES) {
      if (LOCAL_ONLY_EVENT_TYPES.includes(type)) continue;
      sandbox = createSandbox();
      const sender = fakeSender();
      const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json") });
      const r = await runAgentHook(
        adapterReturning(type),
        {},
        { sender, ledger, filteredActivity: { path: sandbox.path("data", "filtered.json") } },
      );
      expect([type, r.outcome]).toEqual([type, "delivered"]);
      expect(sender.sent).toHaveLength(1);
      sandbox.cleanup();
      sandbox = undefined;
    }
  });

  it("no filtered type is one the backend could ever have pushed", () => {
    for (const type of LOCAL_ONLY_EVENT_TYPES) expect(DEFAULT_NOTIFY[type]).toBe(false);
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

/**
 * gcgp.6: every mappable payload records WHICH BUILD of the harness reached us, before any
 * filter can return. Config presence is one fact about a whole harness — all of its builds share
 * one config file — so this tally is the only thing that can tell a delivering build from one
 * that has never fired.
 */
describe("runAgentHook records the build that fired", () => {
  function withVersion(adapter: AgentAdapter, version?: string): AgentAdapter {
    return {
      ...adapter,
      normalizeEvent: async () => {
        const event = await adapter.normalizeEvent({});
        return version === undefined ? event : { ...event, harness_version: version };
      },
    };
  }

  it("counts a delivered event under the build that produced it", async () => {
    sandbox = createSandbox();
    const path = sandbox.path("observed.json");
    await runAgentHook(
      withVersion(adapterReturning("approval_required"), "2.1.229"),
      {},
      {
        sender: fakeSender(),
        ledger: new RecentEventLedger({ path: sandbox.path("ledger.json") }),
        observedBuilds: { path },
      },
    );
    expect(readObservedBuilds({ path })["claude_code"]?.builds["2.1.229"]?.count).toBe(1);
  });

  it("counts a LOCAL-ONLY event too — the build still ran our hook", async () => {
    sandbox = createSandbox();
    const path = sandbox.path("observed.json");
    const localOnly = LOCAL_ONLY_EVENT_TYPES[0];
    expect(localOnly).toBeDefined();
    const sender = fakeSender();
    const result = await runAgentHook(
      withVersion(adapterReturning(localOnly!), "0.148.0-alpha.9"),
      {},
      {
        sender,
        ledger: new RecentEventLedger({ path: sandbox.path("ledger.json") }),
        observedBuilds: { path },
      },
    );
    expect(result.outcome).toBe("filtered");
    expect(sender.sent).toHaveLength(0);
    expect(readObservedBuilds({ path })["claude_code"]?.builds["0.148.0-alpha.9"]?.count).toBe(1);
  });

  it("records nothing for an unmappable payload — no build reached the pipeline", async () => {
    sandbox = createSandbox();
    const path = sandbox.path("observed.json");
    const result = await runAgentHook(
      unmappableAdapter,
      {},
      {
        sender: fakeSender(),
        ledger: new RecentEventLedger({ path: sandbox.path("ledger.json") }),
        observedBuilds: { path },
      },
    );
    expect(result.outcome).toBe("skipped");
    expect(readObservedBuilds({ path })).toEqual({});
  });

  it("counts an event whose harness named no build as unversioned", async () => {
    sandbox = createSandbox();
    const path = sandbox.path("observed.json");
    await runAgentHook(
      adapterReturning("approval_required"),
      {},
      {
        sender: fakeSender(),
        ledger: new RecentEventLedger({ path: sandbox.path("ledger.json") }),
        observedBuilds: { path },
      },
    );
    expect(readObservedBuilds({ path })["claude_code"]).toEqual({ builds: {}, unversioned: 1 });
  });
});
