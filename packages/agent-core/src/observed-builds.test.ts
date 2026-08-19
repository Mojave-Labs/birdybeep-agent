/**
 * Observed-builds tally proof (birdybeep-agent-gcgp.6): which BUILD of a harness has actually run
 * our hook, keyed by (surface, version). Asserts the counters, that the two channels stay apart
 * even on the SAME version, that a harness-supplied version is re-sanitized here (the value is
 * attacker-influenceable, per gcgp.7), that the cap EVICTS rather than discarding future builds,
 * that a tally written before the surface key existed still reads, that the file is owner-only,
 * and that a corrupt file degrades to "nothing observed" instead of breaking `status` / `doctor`.
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearObservedBuilds,
  MAX_OBSERVED_BUILDS,
  observedBuildKey,
  readObservedBuilds,
  recordObservedBuild,
} from "./observed-builds";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function tallyPath(box: Sandbox): string {
  const dir = box.path("data");
  mkdirSync(dir, { recursive: true });
  return join(dir, "observed-builds.json");
}

describe("observed builds", () => {
  it("counts events per build and keeps the two update channels apart", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    recordObservedBuild(
      "claude_code",
      { version: "2.1.227", surface: "terminal" },
      { path, now: () => 1000 },
    );
    recordObservedBuild(
      "claude_code",
      { version: "2.1.227", surface: "terminal" },
      { path, now: () => 2000 },
    );
    recordObservedBuild(
      "claude_code",
      { version: "2.1.229", surface: "desktop" },
      { path, now: () => 3000 },
    );

    const builds = readObservedBuilds({ path })["claude_code"]?.builds ?? {};
    expect(builds[observedBuildKey("terminal", "2.1.227")]).toEqual({
      surface: "terminal",
      version: "2.1.227",
      count: 2,
      firstAt: 1000,
      lastAt: 2000,
    });
    expect(builds[observedBuildKey("desktop", "2.1.229")]?.count).toBe(1);
  });

  it("keeps the SAME version on two surfaces in two entries", () => {
    // The bug this key exists for: one entry served both rows, so a terminal event marked a dead
    // desktop build active.
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    recordObservedBuild("claude_code", { version: "2.1.229", surface: "terminal" }, { path });
    const builds = readObservedBuilds({ path })["claude_code"]?.builds ?? {};
    expect(builds[observedBuildKey("terminal", "2.1.229")]?.count).toBe(1);
    expect(builds[observedBuildKey("desktop", "2.1.229")]).toBeUndefined();
  });

  it("records an unnamed surface as `unknown` rather than guessing one", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    recordObservedBuild("cursor", { version: "3.15.6" }, { path });
    recordObservedBuild("cursor", { version: "3.15.6", surface: "nonsense" }, { path });
    const builds = readObservedBuilds({ path })["cursor"]?.builds ?? {};
    expect(builds[observedBuildKey("unknown", "3.15.6")]?.count).toBe(2);
  });

  it("keeps harnesses separate", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    recordObservedBuild("codex", { version: "0.135.0", surface: "terminal" }, { path });
    recordObservedBuild("codex", { version: "0.148.0-alpha.9", surface: "desktop" }, { path });
    recordObservedBuild("cursor", { version: "3.15.6" }, { path });
    const tally = readObservedBuilds({ path });
    expect(Object.keys(tally["codex"]?.builds ?? {}).sort()).toEqual([
      observedBuildKey("desktop", "0.148.0-alpha.9"),
      observedBuildKey("terminal", "0.135.0"),
    ]);
    expect(Object.keys(tally["cursor"]?.builds ?? {})).toHaveLength(1);
  });

  it("counts an event that named no build as unversioned, not as a build", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    recordObservedBuild("opencode", { version: undefined }, { path });
    recordObservedBuild("codex", { version: "" }, { path });
    const tally = readObservedBuilds({ path });
    expect(tally["opencode"]).toEqual({ builds: {}, unversioned: 1 });
    expect(tally["codex"]).toEqual({ builds: {}, unversioned: 1 });
  });

  it("re-sanitizes the version rather than trusting the caller", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    // The shapes gcgp.7's guard rejects: internal whitespace, a path, the raw AI_AGENT value.
    recordObservedBuild("claude_code", { version: "2.1.229 evil" }, { path });
    recordObservedBuild("claude_code", { version: "../../etc/passwd" }, { path });
    recordObservedBuild("claude_code", { version: "claude-code_2-1-229_harness" }, { path });
    const tally = readObservedBuilds({ path });
    expect(tally["claude_code"]).toEqual({ builds: {}, unversioned: 3 });
  });

  it("evicts the least-recently-observed build at the cap, never the newest", () => {
    // Discarding FUTURE builds was the bug: grading matches only recorded entries, so once the
    // cap filled with history, the build actually running today could never become active.
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    for (let i = 0; i < MAX_OBSERVED_BUILDS; i += 1) {
      recordObservedBuild(
        "codex",
        { version: `0.1.${i}`, surface: "terminal" },
        { path, now: () => 1000 + i },
      );
    }
    recordObservedBuild(
      "codex",
      { version: "0.9.9", surface: "terminal" },
      { path, now: () => 9999 },
    );

    const observation = readObservedBuilds({ path })["codex"];
    expect(Object.keys(observation?.builds ?? {})).toHaveLength(MAX_OBSERVED_BUILDS);
    // The newest build is present and counted...
    expect(observation?.builds[observedBuildKey("terminal", "0.9.9")]?.count).toBe(1);
    // ...the oldest was evicted, and nothing was silently written off as unversioned.
    expect(observation?.builds[observedBuildKey("terminal", "0.1.0")]).toBeUndefined();
    expect(observation?.unversioned).toBe(0);
  });

  it("keeps counting a build that is already recorded once the cap is full", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    for (let i = 0; i < MAX_OBSERVED_BUILDS; i += 1) {
      recordObservedBuild(
        "codex",
        { version: `0.1.${i}`, surface: "terminal" },
        { path, now: () => 1000 + i },
      );
    }
    const newest = observedBuildKey("terminal", `0.1.${MAX_OBSERVED_BUILDS - 1}`);
    recordObservedBuild(
      "codex",
      { version: `0.1.${MAX_OBSERVED_BUILDS - 1}`, surface: "terminal" },
      { path, now: () => 5000 },
    );
    expect(readObservedBuilds({ path })["codex"]?.builds[newest]?.count).toBe(2);
  });

  it("reads a tally written before the surface key existed as `unknown`", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    writeFileSync(
      path,
      JSON.stringify({
        claude_code: {
          builds: { "2.1.227": { count: 3, firstAt: 1, lastAt: 2 } },
          unversioned: 1,
        },
      }),
    );
    const observation = readObservedBuilds({ path })["claude_code"];
    expect(observation?.builds[observedBuildKey("unknown", "2.1.227")]).toEqual({
      surface: "unknown",
      version: "2.1.227",
      count: 3,
      firstAt: 1,
      lastAt: 2,
    });
    expect(observation?.unversioned).toBe(1);
  });

  it("is owner-only on disk", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    recordObservedBuild("cursor", { version: "3.15.6" }, { path });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
  });

  it("degrades to nothing observed when the file is corrupt, and clears cleanly", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    writeFileSync(path, "{not json");
    expect(readObservedBuilds({ path })).toEqual({});

    recordObservedBuild("cursor", { version: "3.15.6" }, { path });
    expect(readObservedBuilds({ path })["cursor"]).toBeDefined();
    clearObservedBuilds({ path });
    expect(readObservedBuilds({ path })).toEqual({});
    clearObservedBuilds({ path }); // idempotent
  });

  it("drops entries that are not the shape we wrote", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    writeFileSync(
      path,
      JSON.stringify({
        claude_code: {
          builds: {
            "terminal:2.1.227": {
              surface: "terminal",
              version: "2.1.227",
              count: 3,
              firstAt: 1,
              lastAt: 2,
            },
          },
          unversioned: 0,
        },
        junk: {
          builds: { "x:not a version!": { count: 1, firstAt: 1, lastAt: 2 } },
          unversioned: 0,
        },
      }),
    );
    const tally = readObservedBuilds({ path });
    expect(tally["claude_code"]?.builds[observedBuildKey("terminal", "2.1.227")]?.count).toBe(3);
    expect(tally["junk"]).toBeUndefined();
  });
});
