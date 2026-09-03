/**
 * CORE-SENDER (part 2): the reliability contract, proven with a stubbed transport.
 * 2xx clears; timeout/5xx/429-ratelimit queue (and the call returns within the fast
 * budget); permanent rejects (401/403/quota/validation) drop and never re-queue; no
 * token → `unpaired`, no network call and nothing queued; the queue drains opportunistically on send;
 * the token rides in the Authorization header and is never logged. The live
 * wrangler-dev delivered-event check is the deferred cross-repo gate.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ErrorCode } from "./api";
import { type BirdyBeepAgentEvent } from "./event";
import { normalizeEvent } from "./normalize";
import { LocalEventQueue, QUEUE_RETENTION_MS } from "./queue";
import { createSender, DEFAULT_SEND_TIMEOUT_MS, DEFAULT_TOTAL_BUDGET_MS } from "./sender";
import { type KeychainBackend } from "./token-store";
import { readUnpairedNotice } from "./unpaired-notice";

let sandbox: Sandbox | undefined;
afterEach(() => {
  vi.useRealTimers();
  sandbox?.cleanup();
  sandbox = undefined;
  vi.restoreAllMocks();
});

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;

/** A keychain backend that just yields a fixed token (no disk, no real keychain). */
function tokenBackend(token: string | null): KeychainBackend {
  return {
    available: true,
    get: () => Promise.resolve(token),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
}

function event(i = 0): BirdyBeepAgentEvent {
  return normalizeEvent(
    {
      event_type: "agent_completed",
      harness: "claude_code",
      source_session_id: `s${i}`,
      machine: { label: "box", os: "linux" },
      workspace: { cwd: "/tmp/x" },
      status: "completed",
      title: "done",
      body: "ok",
    },
    { generateId: () => `evt_${i}`, now: () => "2026-06-14T00:00:00.000Z" },
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorBody(code: ErrorCode) {
  return { error: { code, message: "nope" } };
}

function setup(fetchImpl: typeof fetch, token: string | null = TOKEN, drainMax = 50) {
  sandbox = createSandbox();
  const queue = new LocalEventQueue({ dir: sandbox.path("data", "q") });
  const sender = createSender({
    baseUrl: "http://api.test",
    timeoutMs: 50,
    queue,
    fetchImpl,
    tokenOptions: { backend: tokenBackend(token), filePath: sandbox.path("data", "token") },
    drainMax,
  });
  return { sender, queue };
}

describe("happy path", () => {
  it("a 2xx delivers and does not enqueue", async () => {
    const { sender, queue } = setup(() => Promise.resolve(new Response("{}", { status: 202 })));
    const r = await sender.send(event());
    expect(r.outcome).toBe("delivered");
    expect(queue.size()).toBe(0);
  });

  it("sends the token as a Bearer Authorization header", async () => {
    let seenAuth: string | undefined;
    const { sender } = setup((_url, init) => {
      seenAuth = new Headers(init?.headers).get("authorization") ?? undefined;
      return Promise.resolve(new Response("{}", { status: 202 }));
    });
    await sender.send(event());
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("accepts a healthy six-second production response instead of falsely queueing it", async () => {
    vi.useFakeTimers();
    sandbox = createSandbox();
    const queue = new LocalEventQueue({ dir: sandbox.path("data", "q") });
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(jsonResponse(202, { accepted: true, decision: "notified" })),
            6000,
          );
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;
    const sender = createSender({
      baseUrl: "http://api.test",
      queue,
      fetchImpl,
      tokenOptions: { backend: tokenBackend(TOKEN), filePath: sandbox.path("data", "token") },
    });

    const pending = sender.send(event());
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;

    expect(DEFAULT_SEND_TIMEOUT_MS).toBeGreaterThan(6000);
    expect(DEFAULT_TOTAL_BUDGET_MS).toBeGreaterThan(6000);
    expect(result).toMatchObject({ outcome: "delivered", status: 202, decision: "notified" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);
  });
});

describe("transient failures queue and return fast", () => {
  it("a timeout enqueues and returns within the budget", async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const { sender, queue } = setup(hanging);
    const start = Date.now();
    const r = await sender.send(event());
    const elapsed = Date.now() - start;
    expect(r.outcome).toBe("queued");
    expect(queue.size()).toBe(1);
    expect(elapsed).toBeLessThan(1000); // 50ms timeout → fast return
  });

  it("counts secure-store lookup against the total timeout budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    sandbox = createSandbox();
    const queue = new LocalEventQueue({ dir: sandbox.path("data", "q") });
    const backend: KeychainBackend = {
      available: true,
      get: () => {
        // A slow-but-successful token lookup used 1.5s of the outer 8s budget.
        vi.setSystemTime(1500);
        return Promise.resolve(TOKEN);
      },
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;
    const sender = createSender({
      baseUrl: "http://api.test",
      queue,
      fetchImpl,
      tokenOptions: { backend, filePath: sandbox.path("data", "token") },
      timeoutMs: 8000,
      totalBudgetMs: 8000,
    });

    const pending = sender.send(event());
    await vi.advanceTimersByTimeAsync(6500);
    const result = await pending;

    // The request received only the 6.5s that remained, rather than a fresh 8s after lookup.
    expect(Date.now()).toBe(8000);
    expect(result).toMatchObject({ outcome: "queued", queueCause: "transport" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(1);
  });

  it("a 5xx and a 429 rate_limited both queue", async () => {
    const five = setup(() => Promise.resolve(jsonResponse(500, errorBody("internal_error"))));
    expect((await five.sender.send(event())).outcome).toBe("queued");
    expect(five.queue.size()).toBe(1);

    const rate = setup(() => Promise.resolve(jsonResponse(429, errorBody("rate_limited"))));
    expect((await rate.sender.send(event())).outcome).toBe("queued");
    expect(rate.queue.size()).toBe(1);
  });

  it("reports `failed` when a retryable event cannot be persisted (9u0)", async () => {
    sandbox = createSandbox();
    const blocker = sandbox.path("blocked-data");
    writeFileSync(blocker, "a file where the queue parent directory should be");
    const queue = new LocalEventQueue({ dir: sandbox.path("blocked-data", "queue") });
    const sender = createSender({
      baseUrl: "http://api.test",
      queue,
      fetchImpl: () => Promise.reject(new Error("offline")),
      tokenOptions: { backend: tokenBackend(TOKEN), filePath: sandbox.path("token") },
    });

    const r = await sender.send(event());

    expect(r.outcome).toBe("failed");
    expect(r.queueCause).toBeUndefined(); // nothing was queued, so there is no queue promise
    expect(queue.size()).toBe(0);
  });
});

describe("permanent rejects drop (never re-queue)", () => {
  it.each<ErrorCode>(["unauthorized", "token_revoked", "quota_exceeded", "validation_failed"])(
    "%s → dropped",
    async (code) => {
      const status = code === "validation_failed" ? 400 : code === "unauthorized" ? 401 : 403;
      const { sender, queue } = setup(() => Promise.resolve(jsonResponse(status, errorBody(code))));
      const r = await sender.send(event());
      expect(r.outcome).toBe("dropped");
      expect(r.code).toBe(code);
      expect(queue.size()).toBe(0);
    },
  );
});

describe("no token", () => {
  /**
   * gcgp.4 REGRESSION. The no-token path used to return `queued` — indistinguishable from
   * being offline, and a promise it could never keep: with no token nothing can ever drain,
   * so the events only piled up (1138 files / 4.5 MB / 18.45h on a real machine) until a
   * first pairing flushed the lot at the user's phone.
   */
  it("reports `unpaired` — NOT `queued` — and parks nothing on disk", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response("{}", { status: 202 })));
    const { sender, queue } = setup(fetchSpy, null);
    const r = await sender.send(event());
    expect(r.outcome).toBe("unpaired");
    expect(queue.size()).toBe(0); // nothing to flush on first pair
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /** The discard is RECORDED, so `status`/`doctor` can tell the user what it cost (gcgp.4). */
  it("records the discarded event in the unpaired-activity notice", async () => {
    const { sender } = setup(() => Promise.resolve(new Response("{}", { status: 202 })), null);
    const first = await sender.send(event(1));
    const second = await sender.send(event(2));
    expect(first.unpairedNotice?.count).toBe(1);
    expect(second.unpairedNotice).toMatchObject({ count: 2, harnesses: ["claude_code"] });
    // Metadata only — never a title or a body (§15).
    expect(JSON.stringify(second.unpairedNotice)).not.toContain("done");
    expect(readUnpairedNotice()?.count).toBe(2); // durable: survives the process
  });

  /**
   * 87n + gcgp.4: the no-token path can never drain, and pruning used to live ONLY inside the
   * drain/size read pass — so an unpaired machine grew one file per hook fire forever
   * (observed: 457 entries, oldest two weeks past a 24h retention window). It now enqueues
   * nothing at all, AND still applies retention so a backlog left by an older CLI shrinks.
   */
  it("applies retention to a pre-existing backlog instead of growing it (87n)", async () => {
    sandbox = createSandbox();
    let clock = 1_000_000;
    const queue = new LocalEventQueue({ dir: sandbox.path("data", "q"), now: () => clock });
    const fetchSpy = vi.fn(() => Promise.resolve(new Response("{}", { status: 202 })));
    const sender = createSender({
      baseUrl: "http://api.test",
      queue,
      fetchImpl: fetchSpy,
      tokenOptions: { backend: tokenBackend(null), filePath: sandbox.path("data", "token") },
      noticePath: sandbox.path("data", "unpaired.json"),
      now: () => clock,
    });
    const depth = () => readdirSync(queue.dir).filter((n) => n.endsWith(".json")).length;
    queue.enqueue(event(99)); // what an older CLI would have left behind

    // A fortnight of hook fires on an unpaired machine, one per day — each one lands
    // outside the previous one's 24h window.
    const depths: number[] = [];
    for (let day = 0; day < 14; day++) {
      const r = await sender.send(event(day));
      expect(r.outcome).toBe("unpaired");
      expect(r.drained).toBeDefined(); // doctor/status can see the prune (was undefined)
      depths.push(depth());
      clock += QUEUE_RETENTION_MS + 1;
    }

    expect(fetchSpy).not.toHaveBeenCalled(); // still no network without a token
    expect(depths[0]).toBe(1); // the legacy entry, still inside its window
    expect(depths.slice(1)).toEqual(Array<number>(13).fill(0)); // aged out, and nothing added
  });

  it("prunes on drainNow() even though it cannot send (87n)", async () => {
    sandbox = createSandbox();
    let clock = 0;
    const queue = new LocalEventQueue({ dir: sandbox.path("data", "q"), now: () => clock });
    const sender = createSender({
      baseUrl: "http://api.test",
      queue,
      fetchImpl: () => Promise.reject(new Error("no network expected")),
      tokenOptions: { backend: tokenBackend(null), filePath: sandbox.path("data", "token") },
      now: () => clock,
    });
    for (let i = 0; i < 5; i++) queue.enqueue(event(i));
    clock = QUEUE_RETENTION_MS + 1;
    expect(await sender.drainNow()).toEqual({ delivered: 0, dropped: 0, kept: 0, pruned: 5 });
  });
});

describe("opportunistic drain on send", () => {
  it("flushes the backlog when delivery is healthy", async () => {
    const { sender, queue } = setup(() => Promise.resolve(new Response("{}", { status: 202 })));
    queue.enqueue(event(1));
    queue.enqueue(event(2));
    const r = await sender.send(event(3));
    expect(r.outcome).toBe("delivered");
    expect(r.drained?.delivered).toBe(2); // backlog flushed
    expect(queue.size()).toBe(0);
  });
});

describe("delivery decision surfaced from the 202 body (9fh)", () => {
  it("exposes decision so callers can tell notified from suppressed", async () => {
    const { sender } = setup(() =>
      Promise.resolve(jsonResponse(202, { accepted: true, decision: "suppressed" })),
    );
    const r = await sender.send(event());
    expect(r.outcome).toBe("delivered"); // accepted by the backend…
    expect(r.decision).toBe("suppressed"); // …but no push — callers must not claim a beep
  });

  it("surfaces a `notified` decision from the real accept ack", async () => {
    const { sender } = setup(() =>
      Promise.resolve(jsonResponse(202, { accepted: true, decision: "notified" })),
    );
    const r = await sender.send(event());
    expect(r.outcome).toBe("delivered");
    expect(r.decision).toBe("notified");
  });

  it("tolerates a 2xx with no parseable decision (older backend)", async () => {
    const { sender } = setup(() => Promise.resolve(new Response("", { status: 202 })));
    const r = await sender.send(event());
    expect(r.outcome).toBe("delivered");
    expect(r.decision).toBeUndefined();
  });

  it("ignores an off-contract 2xx body — the decision is validated against agentEventsResponseSchema (kje4)", async () => {
    // Missing `accepted`, and an out-of-enum decision: the loose hand-parse would have
    // surfaced these; the schema-wired parse rejects them → delivered, decision undefined.
    const noAccepted = setup(() => Promise.resolve(jsonResponse(202, { decision: "notified" })));
    expect((await noAccepted.sender.send(event())).decision).toBeUndefined();

    const badDecision = setup(() =>
      Promise.resolve(jsonResponse(202, { accepted: true, decision: "rate_limited" })),
    );
    const r = await badDecision.sender.send(event());
    expect(r.outcome).toBe("delivered");
    expect(r.decision).toBeUndefined();
  });
});

describe("total budget bounds the drain (erm: never outlive the harness hook timeout)", () => {
  it("stops draining when the budget is spent, keeping the remainder queued", async () => {
    sandbox = createSandbox();
    let t = 0;
    const queue = new LocalEventQueue({ dir: sandbox.path("data", "q") });
    const sender = createSender({
      baseUrl: "http://api.test",
      timeoutMs: 3000,
      totalBudgetMs: 1000,
      queue,
      // Each request "takes" 400ms of injected clock — deterministic budget math.
      fetchImpl: () => {
        t += 400;
        return Promise.resolve(new Response("{}", { status: 202 }));
      },
      tokenOptions: { backend: tokenBackend(TOKEN), filePath: sandbox.path("data", "token") },
      now: () => t,
    });
    for (let i = 1; i <= 3; i++) queue.enqueue(event(i));
    const r = await sender.send(event(0));
    expect(r.outcome).toBe("delivered"); // t=400 after the primary send
    // Drain: item1 at t=400 (600ms left) → sends, t=800; item2 has 200ms left (<250ms
    // floor) → the drain stops and the rest stays queued for the next hook.
    expect(r.drained?.delivered).toBe(1);
    expect(r.drained?.kept).toBe(2);
    expect(queue.size()).toBe(2);
  });
});

describe("never logs the token or request body", () => {
  it("no console output contains the token", async () => {
    const sink: string[] = [];
    for (const m of ["log", "error", "warn", "info", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => sink.push(args.join(" ")));
    }
    const { sender } = setup(() => Promise.resolve(jsonResponse(401, errorBody("unauthorized"))));
    await sender.send(event());
    expect(sink.join("\n")).not.toContain(TOKEN);
  });
});

/**
 * birdybeep-agent-gcgp.23. `getToken` returned `null` for a store that ERRORED as well as for one
 * that was empty, so gcgp.4's deliberate drop fired on a machine that is very likely paired —
 * a locked macOS keychain (screen lock, or a login before the first unlock) silently cost the
 * user events and told them they were not paired. A failed read is TRANSIENT: queue it.
 */
describe("token store unavailable (gcgp.23)", () => {
  /** Present and usable, but refusing to answer right now — a locked keychain. */
  function lockedBackend(message = "User interaction is not allowed."): KeychainBackend {
    return {
      available: true,
      get: () => Promise.reject(new Error(message)),
      set: () => Promise.reject(new Error(message)),
      delete: () => Promise.resolve(),
    };
  }

  function lockedSetup(fetchImpl: typeof fetch) {
    sandbox = createSandbox();
    const queue = new LocalEventQueue({ dir: sandbox.path("data", "q") });
    const noticePath = sandbox.path("data", "unpaired.json");
    const sender = createSender({
      baseUrl: "http://api.test",
      timeoutMs: 50,
      queue,
      fetchImpl,
      tokenOptions: { backend: lockedBackend(), filePath: sandbox.path("data", "token") },
      noticePath,
    });
    return { sender, queue, noticePath };
  }

  it("QUEUES the event instead of dropping it, and says why", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response("{}", { status: 202 })));
    const { sender, queue } = lockedSetup(fetchSpy);
    const r = await sender.send(event());
    expect(r.outcome).toBe("queued"); // NOT "unpaired" — nothing said this machine is unpaired
    expect(r.tokenStoreUnavailable?.reason).toContain("User interaction is not allowed");
    expect(r.queueCause).toBe("token_store"); // 0yk: neither offline nor a backend problem
    expect(queue.size()).toBe(1); // the event is parked, not lost
    expect(fetchSpy).not.toHaveBeenCalled(); // no token to send with
  });

  it("does NOT touch the unpaired notice — nothing here was lost while unpaired", async () => {
    const { sender, noticePath } = lockedSetup(() =>
      Promise.resolve(new Response("{}", { status: 202 })),
    );
    const r = await sender.send(event());
    expect(r.unpairedNotice).toBeUndefined();
    expect(readUnpairedNotice({ path: noticePath })).toBeNull();
    expect(readUnpairedNotice()).toBeNull(); // nor the default path under the sandbox HOME
  });

  it("delivers the parked event once the store answers again", async () => {
    sandbox = createSandbox();
    const queue = new LocalEventQueue({ dir: sandbox.path("data", "q") });
    let locked = true;
    const unlockable: KeychainBackend = {
      available: true,
      get: () => (locked ? Promise.reject(new Error("locked")) : Promise.resolve(TOKEN)),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    const posted: string[] = [];
    const sender = createSender({
      baseUrl: "http://api.test",
      queue,
      fetchImpl: ((_url: string, init: RequestInit) => {
        posted.push(typeof init.body === "string" ? init.body : "");
        return Promise.resolve(new Response("{}", { status: 202 }));
      }) as unknown as typeof fetch,
      tokenOptions: { backend: unlockable, filePath: sandbox.path("data", "token") },
    });

    expect((await sender.send(event(1))).outcome).toBe("queued");
    expect(posted).toHaveLength(0);

    locked = false; // the user unlocked their screen
    expect(await sender.drainNow()).toMatchObject({ delivered: 1, kept: 0 });
    expect(posted).toHaveLength(1);
    expect(queue.size()).toBe(0);
  });

  it("drainNow() only prunes while the store is unreadable — the backlog is kept, not dropped", async () => {
    const { sender, queue } = lockedSetup(() => Promise.reject(new Error("no network expected")));
    queue.enqueue(event(1));
    queue.enqueue(event(2));
    expect(await sender.drainNow()).toEqual({ delivered: 0, dropped: 0, kept: 2, pruned: 0 });
    expect(queue.size()).toBe(2); // still there for when the keychain unlocks
  });
});

/**
 * birdybeep-agent-0yk. `send()` decided its outcome BEFORE the opportunistic drain ran, so an
 * event queued after a transient blip and then delivered by that same call's drain was still
 * reported as `queued` — which is how `birdybeep test` came to say "Offline" on a machine that
 * had just delivered the event. The outcome is now reconciled against what the drain actually
 * did to THAT event, tracked by id rather than inferred from the drain counts.
 */
describe("the outcome is reconciled against the drain (0yk)", () => {
  it("reports `delivered` when the drain delivered the event this call just enqueued", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("transient blip"))
        : Promise.resolve(jsonResponse(202, { accepted: true, decision: "notified" }));
    }) as unknown as typeof fetch;
    const { sender, queue } = setup(fetchImpl);

    const r = await sender.send(event());

    expect(r.outcome).toBe("delivered"); // was "queued" while the event was already gone
    expect(r.decision).toBe("notified"); // read off the attempt that actually delivered it
    expect(r.queueCause).toBeUndefined(); // nothing is queued, so nothing has a queue cause
    expect(queue.size()).toBe(0);
    expect(r.drained?.delivered).toBe(1);
  });

  it("reports `dropped` — never `delivered` — when the drain terminally rejects it", async () => {
    let calls = 0;
    const { sender, queue } = setup(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("transient blip"))
        : Promise.resolve(jsonResponse(403, errorBody("quota_exceeded")));
    });

    const r = await sender.send(event());

    expect(r.outcome).toBe("dropped");
    expect(r.code).toBe("quota_exceeded");
    expect(r.status).toBe(403);
    expect(queue.size()).toBe(0); // the drain removed it; it is not waiting to retry
  });

  it("stays `queued` when the drain cannot deliver it either", async () => {
    const { sender, queue } = setup(() => Promise.reject(new Error("offline")));
    const r = await sender.send(event());
    expect(r.outcome).toBe("queued");
    expect(queue.size()).toBe(1);
  });

  /** Identity, not counts: another entry draining says nothing about the event we were asked about. */
  it("does not claim `delivered` because some OTHER queued event drained", async () => {
    const { sender, queue } = setup(((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
        event_id?: string;
      };
      return body.event_id === "evt_7"
        ? Promise.resolve(jsonResponse(500, errorBody("internal_error")))
        : Promise.resolve(new Response("{}", { status: 202 }));
    }) as unknown as typeof fetch);
    queue.enqueue(event(1)); // a backlog entry that CAN be delivered

    const r = await sender.send(event(7));

    expect(r.drained?.delivered).toBe(1); // the backlog entry went…
    expect(r.outcome).toBe("queued"); // …but the event we were asked about did not
    expect(queue.size()).toBe(1);
  });
});

/**
 * birdybeep-agent-0yk (second half). Every queued outcome read as "offline" to callers, so a
 * throttled or 500ing BACKEND told the user to check their network. A queued result now carries
 * why it was queued: a transport failure, the backend asking for a retry, or the token store.
 */
describe("a queued result says WHY it was queued (0yk)", () => {
  it("a transport failure is `transport`", async () => {
    const { sender } = setup(() => Promise.reject(new TypeError("fetch failed")));
    const r = await sender.send(event());
    expect(r.outcome).toBe("queued");
    expect(r.queueCause).toBe("transport");
  });

  it("a timeout is `transport`", async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const r = await setup(hanging).sender.send(event());
    expect(r.queueCause).toBe("transport");
  });

  it("a 5xx is the BACKEND — the request reached it", async () => {
    const { sender } = setup(() => Promise.resolve(jsonResponse(500, errorBody("internal_error"))));
    const r = await sender.send(event());
    expect(r.outcome).toBe("queued");
    expect(r.queueCause).toBe("backend");
    expect(r.status).toBe(500);
  });

  it("a rate_limited 429 is the BACKEND", async () => {
    const { sender } = setup(() => Promise.resolve(jsonResponse(429, errorBody("rate_limited"))));
    const r = await sender.send(event());
    expect(r.queueCause).toBe("backend");
    expect(r.code).toBe("rate_limited");
  });

  it("a bare 503 with no parseable envelope is the BACKEND", async () => {
    const { sender } = setup(() => Promise.resolve(new Response("gateway", { status: 503 })));
    const r = await sender.send(event());
    expect(r.queueCause).toBe("backend");
    expect(r.status).toBe(503);
  });
});

/**
 * birdybeep-agent-0yk (review follow-up). The OUTCOME of a send is the drain's verdict on the
 * watched entry — but the CAUSE is not, and taking both from the same attempt re-created the bug
 * one layer down. The drain re-attempts the event this call just enqueued with a timeout clamped
 * to whatever is left of the total budget (as little as ~250ms), so a definitive backend answer
 * followed by a transport failure milliseconds later is the ORDINARY shape of a 500ing backend —
 * and it was reported as "Offline" for a backend that had answered inside this very call.
 */
describe("a definitive backend answer outlives a transport failure on the drain (0yk)", () => {
  it("keeps `backend` + the 500 when the drain's re-attempt never reaches the backend", async () => {
    let calls = 0;
    const { sender, queue } = setup(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(jsonResponse(500, errorBody("internal_error")))
        : Promise.reject(new TypeError("fetch failed"));
    });

    const r = await sender.send(event());

    expect(calls).toBe(2); // the first POST, then the drain re-attempting that same event
    expect(r.outcome).toBe("queued"); // the drain could not clear it either — it is still parked
    expect(r.queueCause).toBe("backend"); // NOT "transport": the backend answered, moments ago
    expect(r.status).toBe(500); // the evidence is kept, not erased by the answerless re-attempt
    expect(r.code).toBe("internal_error");
    expect(queue.size()).toBe(1);
  });

  it("keeps `backend` + the 429 when the drain's re-attempt times out", async () => {
    let calls = 0;
    const { sender } = setup(((_url: string, init: RequestInit) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(jsonResponse(429, errorBody("rate_limited")));
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch);

    const r = await sender.send(event());

    expect(r.outcome).toBe("queued");
    expect(r.queueCause).toBe("backend"); // throttled, not offline — the retry is automatic
    expect(r.code).toBe("rate_limited");
    expect(r.status).toBe(429);
  });

  it("is still `transport`, with no status to show, when NEITHER attempt reached the backend", async () => {
    let calls = 0;
    const { sender, queue } = setup(() => {
      calls += 1;
      return Promise.reject(new TypeError("fetch failed"));
    });

    const r = await sender.send(event());

    expect(calls).toBe(2); // same two attempts — only the answers differ
    expect(r.outcome).toBe("queued");
    expect(r.queueCause).toBe("transport"); // nothing in this call ever got an answer
    expect(r.status).toBeUndefined();
    expect(r.code).toBeUndefined();
    expect(queue.size()).toBe(1);
  });

  it("prefers the NEWEST backend answer when the drain reaches the backend too", async () => {
    let calls = 0;
    const { sender } = setup(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? jsonResponse(500, errorBody("internal_error"))
          : jsonResponse(429, errorBody("rate_limited")),
      );
    });

    const r = await sender.send(event());

    expect(r.queueCause).toBe("backend");
    expect(r.status).toBe(429); // the older 500 is stale the moment a newer answer arrives
    expect(r.code).toBe("rate_limited");
  });

  it("does not drag an earlier 500 onto an event the drain then DELIVERED", async () => {
    let calls = 0;
    const { sender, queue } = setup(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? jsonResponse(500, errorBody("internal_error"))
          : jsonResponse(202, { accepted: true, decision: "notified" }),
      );
    });

    const r = await sender.send(event());

    expect(r.outcome).toBe("delivered");
    expect(r.status).toBe(202);
    expect(r.code).toBeUndefined(); // the 500 is history: this event is gone, successfully
    expect(r.queueCause).toBeUndefined();
    expect(r.decision).toBe("notified");
    expect(queue.size()).toBe(0);
  });
});
