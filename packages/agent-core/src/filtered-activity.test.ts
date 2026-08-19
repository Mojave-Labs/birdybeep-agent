/**
 * gcgp.3 — the local tally that keeps a filtered event visible to `status`/`doctor`.
 * Absent-file, accumulate, per-type breakdown, bounded growth, corrupt-file tolerance.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearFilteredActivity,
  readFilteredActivity,
  recordFilteredEvent,
} from "./filtered-activity";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function tally(): string {
  sandbox = createSandbox();
  return sandbox.path("data", "filtered-events.json");
}

describe("filtered-activity tally", () => {
  it("reads null before anything is recorded", () => {
    expect(readFilteredActivity({ path: tally() })).toBeNull();
  });

  it("accumulates a count, a per-type breakdown, and first/last timestamps", () => {
    const path = tally();
    let t = 1_000;
    const now = () => t;
    recordFilteredEvent("tool_finished", { path, now });
    t = 5_000;
    recordFilteredEvent("tool_finished", { path, now });
    t = 9_000;
    recordFilteredEvent("tool_started", { path, now });

    const activity = readFilteredActivity({ path });
    expect(activity).toEqual({
      count: 3,
      firstAt: 1_000,
      lastAt: 9_000,
      byType: { tool_finished: 2, tool_started: 1 },
    });
  });

  it("records only metadata — no title, body, path or session id can reach the file", () => {
    const path = tally();
    recordFilteredEvent("tool_finished", { path });
    const raw = JSON.stringify(readFilteredActivity({ path }));
    expect(raw).not.toMatch(/\//); // no path separators of any kind
    expect(Object.keys(readFilteredActivity({ path })?.byType ?? {})).toEqual(["tool_finished"]);
  });

  it("cannot grow without bound: distinct types are capped, existing ones keep counting", () => {
    const path = tally();
    for (let i = 0; i < 40; i += 1) recordFilteredEvent(`type_${i}`, { path });
    const activity = readFilteredActivity({ path });
    expect(activity?.count).toBe(40); // the total is always exact…
    expect(Object.keys(activity?.byType ?? {})).toHaveLength(16); // …the breakdown is bounded
    recordFilteredEvent("type_0", { path });
    expect(readFilteredActivity({ path })?.byType["type_0"]).toBe(2); // known type still counts
  });

  it("tolerates a corrupt file and never throws into the hot path", () => {
    const path = tally();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");
    expect(readFilteredActivity({ path })).toBeNull();
    expect(recordFilteredEvent("tool_finished", { path })?.count).toBe(1); // rewritten in place
  });

  it("clear() removes the tally and is a safe no-op when absent", () => {
    const path = tally();
    recordFilteredEvent("tool_finished", { path });
    clearFilteredActivity({ path });
    expect(readFilteredActivity({ path })).toBeNull();
    expect(() => clearFilteredActivity({ path })).not.toThrow();
  });
});
