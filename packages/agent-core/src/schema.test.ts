/**
 * CORE-SCHEMA proof: validation behavior + cross-repo PARITY with the product
 * `packages/schemas`. The lockstep guard is a VENDORED fixture — the exact §10.2
 * canonical payload and the exact §10.1/§10.4/§9.5–9.7 enum vocabularies copied
 * from the product. If the agent schema drifts from these vendored values, this
 * suite fails. (Update the vendored values in lockstep whenever the product
 * `packages/schemas` / `@birdybeep/shared` changes — that is the §16.4 contract.)
 */
import { describe, expect, it } from "vitest";

import canonicalEvent from "./__fixtures__/canonical-event.json";
import {
  birdyBeepAgentEventSchema,
  eventTypeSchema,
  harnessSchema,
  isWithinMaxAgentEventSize,
  MAX_AGENT_EVENT_BYTES,
  sessionStatusSchema,
} from "./index";

// ── VENDORED from the product @birdybeep/shared (keep identical, §16.4) ──
const PRODUCT_EVENT_TYPES = [
  "session_started",
  "session_resumed",
  "session_active",
  "needs_input",
  "approval_required",
  "agent_idle",
  "agent_completed",
  "agent_failed",
  "test_failed",
  "tool_started",
  "tool_finished",
  "subagent_started",
  "subagent_completed",
  "custom",
  "test", // 9fh: the `birdybeep test` diagnostic — notify-by-default, quota-exempt server-side
  "session_ended", // true end-of-session marker (non-notifying) — appended last
];
const PRODUCT_SESSION_STATUSES = [
  "starting",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "idle",
  "completed",
  "failed",
  "unknown",
];
const PRODUCT_HARNESS_IDS = ["claude_code", "codex", "opencode"];

function without(key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(canonicalEvent as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

describe("parity: the product's canonical §10.2 payload validates identically here", () => {
  it("accepts the vendored product fixture", () => {
    expect(birdyBeepAgentEventSchema.safeParse(canonicalEvent).success).toBe(true);
  });

  it("enums mirror the product unions exactly, in order", () => {
    expect([...eventTypeSchema.options]).toEqual(PRODUCT_EVENT_TYPES);
    expect([...sessionStatusSchema.options]).toEqual(PRODUCT_SESSION_STATUSES);
    expect([...harnessSchema.options]).toEqual(PRODUCT_HARNESS_IDS);
  });
});

describe("validation: an invalid event rejects (§10.2)", () => {
  it("rejects a payload missing a required field (event_type)", () => {
    expect(birdyBeepAgentEventSchema.safeParse(without("event_type")).success).toBe(false);
  });

  it("rejects a missing required object (machine)", () => {
    expect(birdyBeepAgentEventSchema.safeParse(without("machine")).success).toBe(false);
  });

  it("rejects an unknown event_type, naming event_type in the error", () => {
    const result = birdyBeepAgentEventSchema.safeParse({
      ...canonicalEvent,
      event_type: "not_a_real_event",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("event_type"))).toBe(true);
    }
  });

  it("rejects an out-of-union status", () => {
    expect(
      birdyBeepAgentEventSchema.safeParse({ ...canonicalEvent, status: "vibing" }).success,
    ).toBe(false);
  });

  it("rejects a non-ISO occurred_at", () => {
    expect(
      birdyBeepAgentEventSchema.safeParse({ ...canonicalEvent, occurred_at: "yesterday" }).success,
    ).toBe(false);
  });
});

describe("optional fields + open metadata (§10.2)", () => {
  it("accepts a minimal payload omitting all optional fields", () => {
    const minimal = {
      event_id: "evt_1",
      event_type: "agent_idle",
      occurred_at: "2026-06-11T12:34:56.000Z",
      harness: "codex",
      source_session_id: "s1",
      machine: { label: "box", os: "linux" },
      workspace: { cwd: "/srv/app" },
      status: "idle",
      title: "",
      body: "",
    };
    expect(birdyBeepAgentEventSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts arbitrary extra metadata keys (open record) without leaking them out", () => {
    const result = birdyBeepAgentEventSchema.safeParse({
      ...canonicalEvent,
      metadata: { tool: "Edit", anything: { nested: true }, count: 3 },
    });
    expect(result.success).toBe(true);
  });
});

describe("max payload size guard (§13.5)", () => {
  it("accepts a body at the cap and rejects an oversized one", () => {
    expect(isWithinMaxAgentEventSize(MAX_AGENT_EVENT_BYTES)).toBe(true);
    expect(isWithinMaxAgentEventSize(MAX_AGENT_EVENT_BYTES + 1)).toBe(false);
    expect(isWithinMaxAgentEventSize(new Uint8Array(MAX_AGENT_EVENT_BYTES + 1))).toBe(false);
  });
});
