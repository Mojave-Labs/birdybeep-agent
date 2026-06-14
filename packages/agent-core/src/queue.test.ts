/**
 * CORE-QUEUE proof: strict perms, 24h retention, restart-survival, bounded drain,
 * and drain-ONCE under concurrent drains — all against a hermetic temp HOME (the
 * queue resolves its dir from the sandbox-redirected data dir, proving real path
 * resolution). The live wrangler-dev drain E2E is the deferred cross-repo gate.
 */
import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { type BirdyBeepAgentEvent } from "./event";
import { normalizeEvent } from "./normalize";
import { birdyBeepDataDir } from "./paths";
import { type DrainOutcome, LocalEventQueue, QUEUE_RETENTION_MS } from "./queue";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function makeEvent(i: number): BirdyBeepAgentEvent {
  return normalizeEvent(
    {
      event_type: "agent_completed",
      harness: "claude_code",
      source_session_id: `s${i}`,
      machine: { label: "box", os: "linux" },
      workspace: { cwd: "/tmp/proj" },
      status: "completed",
      title: "done",
      body: "ok",
    },
    { generateId: () => `evt_${i}`, now: () => "2026-06-14T00:00:00.000Z" },
  );
}

const POSIX = process.platform !== "win32";

describe("location + strict permissions (§15.3)", () => {
  it("defaults under the user data dir (not repo-local) and creates 0700/0600", () => {
    sandbox = createSandbox();
    const q = new LocalEventQueue();
    expect(q.dir.startsWith(birdyBeepDataDir())).toBe(true);
    expect(q.dir.startsWith(sandbox.home)).toBe(true);
    expect(q.dir).not.toContain("birdybeep-agent/packages"); // never in the repo
    q.enqueue(makeEvent(1));
    expect(q.isSecure()).toBe(true);
    if (POSIX) {
      expect(statSync(q.dir).mode & 0o777).toBe(0o700);
      const jsonName = readdirSync(q.dir).find((n) => n.endsWith(".json"));
      expect(jsonName).toBeDefined();
      expect(statSync(join(q.dir, jsonName!)).mode & 0o777).toBe(0o600);
    }
  });

  it("repairs a too-permissive existing dir on access", () => {
    if (!POSIX) return;
    sandbox = createSandbox();
    const dir = sandbox.path("data", "queue");
    const q = new LocalEventQueue({ dir });
    q.enqueue(makeEvent(1)); // creates 0700
    // Loosen it, then a fresh access must repair it.
    chmodSync(dir, 0o755);
    new LocalEventQueue({ dir }).size();
    expect((statSync(dir).mode & 0o077) === 0).toBe(true);
  });
});

describe("24h retention (§15.3)", () => {
  it("prunes entries older than the retention window and never drains them", async () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    new LocalEventQueue({ dir, now: () => 0 }).enqueue(makeEvent(1)); // enqueuedAt = epoch
    const fresh = new LocalEventQueue({ dir, now: () => QUEUE_RETENTION_MS + 1 });
    expect(fresh.size()).toBe(0);
    const drained: string[] = [];
    await fresh.drain((e) => {
      drained.push(e.event_id);
      return "delivered";
    });
    expect(drained).toEqual([]);
  });

  it("keeps entries within the window", () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    new LocalEventQueue({ dir, now: () => 0 }).enqueue(makeEvent(1));
    expect(new LocalEventQueue({ dir, now: () => QUEUE_RETENTION_MS - 1 }).size()).toBe(1);
  });
});

describe("durability + drain semantics", () => {
  it("survives a process restart (new instance, same dir)", () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    const writer = new LocalEventQueue({ dir });
    for (let i = 0; i < 3; i++) writer.enqueue(makeEvent(i));
    expect(new LocalEventQueue({ dir }).size()).toBe(3);
  });

  it("delivered/drop remove the entry; retry keeps it", async () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    const q = new LocalEventQueue({ dir });
    q.enqueue(makeEvent(0)); // -> delivered
    q.enqueue(makeEvent(1)); // -> drop
    q.enqueue(makeEvent(2)); // -> retry
    const outcomes: Record<string, DrainOutcome> = {
      evt_0: "delivered",
      evt_1: "drop",
      evt_2: "retry",
    };
    const r = await q.drain((e) => outcomes[e.event_id] ?? "retry");
    expect(r).toMatchObject({ delivered: 1, dropped: 1, kept: 1 });
    expect(q.size()).toBe(1); // only the retried one remains
  });

  it("a throwing sender keeps the event for next time", async () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    const q = new LocalEventQueue({ dir });
    q.enqueue(makeEvent(0));
    const r = await q.drain(() => {
      throw new Error("network down");
    });
    expect(r.kept).toBe(1);
    expect(q.size()).toBe(1);
  });

  it("drain is bounded by max", async () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    const q = new LocalEventQueue({ dir });
    for (let i = 0; i < 100; i++) q.enqueue(makeEvent(i));
    const r = await q.drain(() => "delivered", { max: 10 });
    expect(r.delivered).toBe(10);
    expect(q.size()).toBe(90);
  });

  it("clear() empties the queue", () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    const q = new LocalEventQueue({ dir });
    for (let i = 0; i < 5; i++) q.enqueue(makeEvent(i));
    expect(q.clear()).toBeGreaterThanOrEqual(5);
    expect(q.size()).toBe(0);
  });
});

describe("concurrency: two simultaneous drains never double-send", () => {
  it("delivers each event exactly once across concurrent drains", async () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    const q = new LocalEventQueue({ dir });
    const N = 25;
    for (let i = 0; i < N; i++) q.enqueue(makeEvent(i));
    const seen = new Map<string, number>();
    const send = async (e: BirdyBeepAgentEvent): Promise<DrainOutcome> => {
      await Promise.resolve(); // force an await boundary so drains interleave
      seen.set(e.event_id, (seen.get(e.event_id) ?? 0) + 1);
      return "delivered";
    };
    const [r1, r2] = await Promise.all([q.drain(send), q.drain(send)]);
    expect(r1.delivered + r2.delivered).toBe(N);
    expect(seen.size).toBe(N);
    for (const count of seen.values()) expect(count).toBe(1);
    expect(q.size()).toBe(0);
  });
});
