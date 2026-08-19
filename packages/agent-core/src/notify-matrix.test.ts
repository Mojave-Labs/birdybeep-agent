/**
 * gcgp.3 — the DRIFT GUARD for the client-side send filter.
 *
 * Three things have to stay true, and each of them fails CI on its own:
 *   1. the mirrored §10.5 matrix equals the product's `@birdybeep/shared` DEFAULT_NOTIFY
 *      EXACTLY (asserted against the vendored snapshot, which is a byte-for-byte copy of
 *      the product's `packages/shared/src/__fixtures__/default-notify.json`);
 *   2. every event type is CLASSIFIED — adding one to §10.1 without deciding its
 *      disposition fails here as well as at compile time;
 *   3. the filter only ever withholds types the matrix says can never notify. That is the
 *      safety property: no change to the disposition table can silence a real beep.
 */
import { describe, expect, it } from "vitest";

import productDefaultNotify from "./__fixtures__/product-default-notify.json";
import {
  DEFAULT_NOTIFY,
  EVENT_DISPOSITION,
  isNotifiableEventType,
  LOCAL_ONLY_EVENT_TYPES,
  shouldSendEventType,
} from "./notify-matrix";
import { BIRDYBEEP_EVENT_TYPES } from "./primitives";

describe("parity with the product's §10.5 DEFAULT_NOTIFY (§16.4 lockstep)", () => {
  it("the mirrored matrix equals the vendored product snapshot, key for key", () => {
    expect(DEFAULT_NOTIFY).toEqual(productDefaultNotify);
  });

  it("the snapshot covers exactly the §10.1 vocabulary (no stale or missing type)", () => {
    expect(Object.keys(productDefaultNotify).sort()).toEqual([...BIRDYBEEP_EVENT_TYPES].sort());
  });

  it("notifies for exactly the six attention events + the `test` diagnostic (9fh)", () => {
    expect(BIRDYBEEP_EVENT_TYPES.filter((t) => DEFAULT_NOTIFY[t]).sort()).toEqual(
      [
        "agent_completed",
        "agent_failed",
        "agent_idle",
        "approval_required",
        "needs_input",
        "test",
        "test_failed",
      ].sort(),
    );
  });

  it("isNotifiableEventType reads the same table (and is false for anything unknown)", () => {
    for (const type of BIRDYBEEP_EVENT_TYPES) {
      expect(isNotifiableEventType(type)).toBe(DEFAULT_NOTIFY[type]);
    }
    expect(isNotifiableEventType("not_a_real_event")).toBe(false);
  });
});

describe("the disposition table is total and self-consistent", () => {
  it("classifies every §10.1 event type", () => {
    expect(Object.keys(EVENT_DISPOSITION).sort()).toEqual([...BIRDYBEEP_EVENT_TYPES].sort());
  });

  it("DEFAULT_NOTIFY is exactly the `notify` column", () => {
    for (const type of BIRDYBEEP_EVENT_TYPES) {
      expect(DEFAULT_NOTIFY[type]).toBe(EVENT_DISPOSITION[type] === "notify");
    }
  });
});

describe("the client filter can never silence a beep", () => {
  it("EVERY withheld type is non-notifying in the mirrored matrix", () => {
    for (const type of LOCAL_ONLY_EVENT_TYPES) {
      expect(DEFAULT_NOTIFY[type]).toBe(false);
    }
  });

  it("sends every notifiable type", () => {
    for (const type of BIRDYBEEP_EVENT_TYPES) {
      if (DEFAULT_NOTIFY[type]) expect(shouldSendEventType(type)).toBe(true);
    }
  });

  it("withholds exactly the per-tool-call family (the measured 88.5%)", () => {
    expect([...LOCAL_ONLY_EVENT_TYPES]).toEqual(["tool_started", "tool_finished"]);
    expect(shouldSendEventType("tool_finished")).toBe(false);
    expect(shouldSendEventType("tool_started")).toBe(false);
  });

  it("still SENDS the non-notifying types the worker needs", () => {
    // Not "notify=false ⇒ drop". The worker upserts the session row, advances last_seen, and
    // — for Codex — promotes a needs_trust integration to installed on a delivered
    // trust-gated hook event. session_started is what carries that for a session with no
    // approval prompt, so dropping it would strand working installs in needs_trust.
    for (const type of [
      "session_started",
      "session_resumed",
      "session_active",
      "session_ended",
      "subagent_started",
      "subagent_completed",
      "custom",
    ] as const) {
      expect(DEFAULT_NOTIFY[type]).toBe(false); // never notifies…
      expect(shouldSendEventType(type)).toBe(true); // …and is still sent
    }
  });

  it("fails OPEN on an unrecognized type (an unclassifiable event is never dropped)", () => {
    expect(shouldSendEventType("some_future_event")).toBe(true);
  });
});
