/**
 * CORE-QUEUE proof: strict perms, 24h retention, restart-survival, bounded drain,
 * and drain-ONCE under concurrent drains — all against a hermetic temp HOME (the
 * queue resolves its dir from the sandbox-redirected data dir, proving real path
 * resolution). The live wrangler-dev drain E2E is the deferred cross-repo gate.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { type BirdyBeepAgentEvent } from "./event";
import { normalizeEvent } from "./normalize";
import { birdyBeepDataDir } from "./paths";
import { CLAIM_RECLAIM_MS, type DrainOutcome, LocalEventQueue, QUEUE_RETENTION_MS } from "./queue";

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

describe("prune(): retention without a send (87n)", () => {
  it("drops expired entries, keeps fresh ones, and reports both", () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    let t = 0;
    const q = new LocalEventQueue({ dir, now: () => t });
    for (let i = 0; i < 3; i++) q.enqueue(makeEvent(i)); // enqueuedAt = 0 → will expire
    t = QUEUE_RETENTION_MS + 1;
    q.enqueue(makeEvent(99)); // inside the window → survives

    const r = q.prune();
    expect(r).toEqual({ delivered: 0, dropped: 0, kept: 1, pruned: 3 });
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it("removes corrupt entries", () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    const q = new LocalEventQueue({ dir });
    q.enqueue(makeEvent(0));
    writeFileSync(join(dir, "9999999999999-garbage.json"), "{not json", { mode: 0o600 });
    expect(q.prune()).toMatchObject({ kept: 1, pruned: 1 });
  });

  it("is a no-op on an absent queue dir and never throws", () => {
    sandbox = createSandbox();
    const q = new LocalEventQueue({ dir: sandbox.path("data", "never-created") });
    expect(q.prune()).toEqual({ delivered: 0, dropped: 0, kept: 0, pruned: 0 });
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

describe("orphaned-claim reclaim (erm)", () => {
  it("returns a stale .claim (killed mid-drain) to the queue and delivers it", async () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    let t = 1_000_000;
    const q = new LocalEventQueue({ dir, now: () => t });
    q.enqueue(makeEvent(0));
    // Simulate a drain that claimed the entry and was then KILLED before settling it
    // (a thrown sender releases its claim, so build the orphan the way a dead process
    // leaves it: the entry renamed to a timestamped .claim, never renamed back).
    const name = readdirSync(dir).find((n) => n.endsWith(".json"))!;
    const { renameSync } = await import("node:fs");
    renameSync(join(dir, name), join(dir, `${name}.${t}-dead-beef.claim`));
    expect(q.size()).toBe(0); // invisible while claimed — this is the stranding bug
    t += CLAIM_RECLAIM_MS + 1; // past the reclaim window → the claim is orphaned
    const delivered: string[] = [];
    const r = await q.drain((e) => {
      delivered.push(e.event_id);
      return "delivered";
    });
    expect(r.delivered).toBe(1);
    expect(delivered).toEqual(["evt_0"]); // the stranded event finally went out
  });

  it("leaves a FRESH claim alone (an active drain still owns it)", async () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    let t = 1_000_000;
    const q = new LocalEventQueue({ dir, now: () => t });
    q.enqueue(makeEvent(0));
    const name = readdirSync(dir).find((n) => n.endsWith(".json"))!;
    const { renameSync } = await import("node:fs");
    renameSync(join(dir, name), join(dir, `${name}.${t}-dead-beef.claim`));
    t += CLAIM_RECLAIM_MS - 1_000; // inside the window → presumed in flight
    const r = await q.drain(() => "delivered");
    expect(r.delivered).toBe(0); // not stolen from the (presumed) live drain
  });
});

describe("drain stopWhen (sender budget bound — erm)", () => {
  it("stops claiming once stopWhen trips, keeping the remainder queued", async () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    const q = new LocalEventQueue({ dir });
    for (let i = 0; i < 5; i++) q.enqueue(makeEvent(i));
    let sends = 0;
    const r = await q.drain(
      () => {
        sends += 1;
        return "delivered";
      },
      { stopWhen: () => sends >= 2 }, // budget exhausted after two sends
    );
    expect(r.delivered).toBe(2);
    expect(r.kept).toBe(3); // untouched, still queued for the next drain
    expect(q.size()).toBe(3);
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

/**
 * birdybeep-agent-gcgp.4: age was the ONLY bound. A machine that could not deliver grew one
 * file per hook fire until the 24h window caught up — 1138 files / 4.5 MB in the field, all of
 * which would have been POSTed on the first successful pair.
 */
describe("count cap (gcgp.4)", () => {
  it("REPRO/FIX: growth is bounded by the cap, and the drops are counted", () => {
    sandbox = createSandbox();
    const q = new LocalEventQueue({ dir: sandbox.path("data", "q"), maxEntries: 20 });
    const depth = (): number => readdirSync(q.dir).filter((n) => n.endsWith(".json")).length;

    const depths: number[] = [];
    for (let i = 0; i < 100; i++) {
      q.enqueue(makeEvent(i));
      depths.push(depth());
    }

    expect(Math.max(...depths)).toBe(20); // bounded, NOT 100 (was: unbounded)
    expect(q.size()).toBe(20);
    expect(q.overflowDropCount()).toBe(80); // and the loss is recorded, not silent
  });

  it("drops the OLDEST first — the newest event is never the one refused", async () => {
    sandbox = createSandbox();
    let clock = 1_000_000;
    const q = new LocalEventQueue({
      dir: sandbox.path("data", "q"),
      maxEntries: 3,
      now: () => clock,
    });
    for (let i = 0; i < 6; i++) {
      q.enqueue(makeEvent(i));
      clock += 1000;
    }
    const drained: string[] = [];
    await q.drain((e) => {
      drained.push(e.event_id);
      return "delivered";
    });
    expect(drained).toEqual(["evt_3", "evt_4", "evt_5"]); // evt_0..2 dropped as oldest
  });

  it("prune() applies the cap too, so a backlog from an older CLI is trimmed on first contact", () => {
    sandbox = createSandbox();
    const dir = sandbox.path("data", "q");
    // What an unbounded predecessor left behind.
    const legacy = new LocalEventQueue({ dir, maxEntries: Number.MAX_SAFE_INTEGER });
    for (let i = 0; i < 60; i++) legacy.enqueue(makeEvent(i));
    expect(legacy.size()).toBe(60);

    const q = new LocalEventQueue({ dir, maxEntries: 10 });
    expect(q.prune()).toEqual({ delivered: 0, dropped: 0, kept: 10, pruned: 0 });
    expect(q.size()).toBe(10);
    expect(q.overflowDropCount()).toBe(50);
  });

  it("the counter file is not mistaken for a queued event", () => {
    sandbox = createSandbox();
    const q = new LocalEventQueue({ dir: sandbox.path("data", "q"), maxEntries: 1 });
    q.enqueue(makeEvent(1));
    q.enqueue(makeEvent(2)); // forces a drop → writes the counter
    expect(q.overflowDropCount()).toBe(1);
    expect(q.size()).toBe(1); // the counter is not counted as an entry
    expect(q.clear()).toBe(1); // …nor reported as one that was cleared
    expect(q.overflowDropCount()).toBe(0);
  });
});

/**
 * The cold-start guard (gcgp.4): `pair` calls this the instant a token is stored so a first
 * pairing does not replay the backlog the machine built up while it had nowhere to send.
 */
describe("discardBefore — the cold-start guard (gcgp.4)", () => {
  it("discards everything queued before the cutoff and keeps everything after", async () => {
    sandbox = createSandbox();
    let clock = 1_000_000;
    const q = new LocalEventQueue({ dir: sandbox.path("data", "q"), now: () => clock });
    for (let i = 0; i < 5; i++) {
      q.enqueue(makeEvent(i)); // "before pairing"
      clock += 10;
    }
    const pairedAt = clock;
    clock += 10;
    q.enqueue(makeEvent(99)); // "after pairing" — an ordinary offline retry

    expect(q.discardBefore(pairedAt)).toBe(5);
    const drained: string[] = [];
    await q.drain((e) => {
      drained.push(e.event_id);
      return "delivered";
    });
    expect(drained).toEqual(["evt_99"]); // no storm: only the post-pairing event delivers
  });

  // gcgp.24: entry timestamps are milliseconds, so an event enqueued in the SAME millisecond as
  // pairing is ambiguous. While the boundary was exclusive, `>=` kept it and the guard's outcome
  // depended on sub-millisecond timing — a same-ms entry survived 133/200 probe runs and flaked
  // the pre-push gate at ~1 run in 5. The clock is injected, so this asserts the boundary itself
  // rather than racing it: the failure mode WAS nondeterminism, and a test that could only catch
  // it by chance would be the same bug in test form.
  it("discards an entry stamped EXACTLY at the cutoff — the boundary is inclusive", async () => {
    sandbox = createSandbox();
    let clock = 1_000_000;
    const q = new LocalEventQueue({ dir: sandbox.path("data", "q"), now: () => clock });

    q.enqueue(makeEvent(1)); // strictly before the cutoff
    clock += 10;
    const pairedAt = clock;
    q.enqueue(makeEvent(2)); // the ambiguous one — same millisecond as pairing
    clock += 1;
    q.enqueue(makeEvent(3)); // unambiguously after

    expect(q.discardBefore(pairedAt)).toBe(2); // the earlier AND the same-ms entry both go
    const drained: string[] = [];
    await q.drain((e) => {
      drained.push(e.event_id);
      return "delivered";
    });
    expect(drained).toEqual(["evt_3"]);
  });

  it("takes stale .claim files too, so an orphan can't rejoin the queue and deliver", () => {
    sandbox = createSandbox();
    let clock = 1_000_000;
    const dir = sandbox.path("data", "q");
    const q = new LocalEventQueue({ dir, now: () => clock });
    q.enqueue(makeEvent(1));
    // Simulate a drainer killed mid-send: its entry is parked under a `.claim` name.
    const entry = readdirSync(dir).find((n) => n.endsWith(".json"))!;
    renameSync(join(dir, entry), join(dir, `${entry}.${clock}-${randomUUID()}.claim`));

    clock += 10;
    q.discardBefore(clock);
    clock += CLAIM_RECLAIM_MS + 1; // long enough that the orphan would be reclaimed
    expect(q.size()).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("is a no-op on a queue with nothing older than the cutoff", () => {
    sandbox = createSandbox();
    const q = new LocalEventQueue({ dir: sandbox.path("data", "q") });
    q.enqueue(makeEvent(1));
    expect(q.discardBefore(1)).toBe(0);
    expect(q.size()).toBe(1);
  });
});
