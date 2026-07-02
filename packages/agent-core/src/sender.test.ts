/**
 * CORE-SENDER (part 2): the reliability contract, proven with a stubbed transport.
 * 2xx clears; timeout/5xx/429-ratelimit queue (and the call returns within the fast
 * budget); permanent rejects (401/403/quota/validation) drop and never re-queue; no
 * token → queued without a network call; the queue drains opportunistically on send;
 * the token rides in the Authorization header and is never logged. The live
 * wrangler-dev delivered-event check is the deferred cross-repo gate.
 */
import { randomUUID } from "node:crypto";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ErrorCode } from "./api";
import { type BirdyBeepAgentEvent } from "./event";
import { normalizeEvent } from "./normalize";
import { LocalEventQueue } from "./queue";
import { createSender } from "./sender";
import { type KeychainBackend } from "./token-store";

let sandbox: Sandbox | undefined;
afterEach(() => {
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

  it("a 5xx and a 429 rate_limited both queue", async () => {
    const five = setup(() => Promise.resolve(jsonResponse(500, errorBody("internal_error"))));
    expect((await five.sender.send(event())).outcome).toBe("queued");
    expect(five.queue.size()).toBe(1);

    const rate = setup(() => Promise.resolve(jsonResponse(429, errorBody("rate_limited"))));
    expect((await rate.sender.send(event())).outcome).toBe("queued");
    expect(rate.queue.size()).toBe(1);
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
  it("queues without making a network call", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response("{}", { status: 202 })));
    const { sender, queue } = setup(fetchSpy, null);
    const r = await sender.send(event());
    expect(r.outcome).toBe("queued");
    expect(queue.size()).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("tolerates a 2xx with no parseable decision (older backend)", async () => {
    const { sender } = setup(() => Promise.resolve(new Response("", { status: 202 })));
    const r = await sender.send(event());
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
