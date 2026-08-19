/**
 * Observed-builds tally proof (birdybeep-agent-gcgp.6): which BUILD of a harness has actually
 * run our hook. Asserts the counters, that a harness-supplied version is re-sanitized here (the
 * value is attacker-influenceable, per gcgp.7), that the file cannot grow with input, that it
 * is written owner-only, and that a corrupt file degrades to "nothing observed" instead of
 * breaking `status` / `doctor`.
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { clearObservedBuilds, readObservedBuilds, recordObservedBuild } from "./observed-builds";

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
    const now = () => 1000;
    recordObservedBuild("claude_code", "2.1.227", { path, now });
    recordObservedBuild("claude_code", "2.1.227", { path, now: () => 2000 });
    recordObservedBuild("claude_code", "2.1.229", { path, now: () => 3000 });

    const tally = readObservedBuilds({ path });
    expect(tally["claude_code"]?.builds).toEqual({
      "2.1.227": { count: 2, firstAt: 1000, lastAt: 2000 },
      "2.1.229": { count: 1, firstAt: 3000, lastAt: 3000 },
    });
    expect(tally["claude_code"]?.unversioned).toBe(0);
  });

  it("keeps harnesses separate", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    recordObservedBuild("codex", "0.135.0", { path });
    recordObservedBuild("codex", "0.148.0-alpha.9", { path });
    recordObservedBuild("cursor", "3.15.6", { path });
    const tally = readObservedBuilds({ path });
    expect(Object.keys(tally["codex"]?.builds ?? {}).sort()).toEqual([
      "0.135.0",
      "0.148.0-alpha.9",
    ]);
    expect(Object.keys(tally["cursor"]?.builds ?? {})).toEqual(["3.15.6"]);
  });

  it("counts an event that named no build as unversioned, not as a build", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    recordObservedBuild("opencode", undefined, { path });
    recordObservedBuild("codex", "", { path });
    const tally = readObservedBuilds({ path });
    expect(tally["opencode"]).toEqual({ builds: {}, unversioned: 1 });
    expect(tally["codex"]).toEqual({ builds: {}, unversioned: 1 });
  });

  it("re-sanitizes the version rather than trusting the caller", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    // The shapes gcgp.7's guard rejects: internal whitespace, a path, the raw AI_AGENT value.
    recordObservedBuild("claude_code", "2.1.229 evil", { path });
    recordObservedBuild("claude_code", "../../etc/passwd", { path });
    recordObservedBuild("claude_code", "claude-code_2-1-229_harness", { path });
    const tally = readObservedBuilds({ path });
    expect(tally["claude_code"]).toEqual({ builds: {}, unversioned: 3 });
  });

  it("cannot grow without bound — extra builds fall back to the unversioned counter", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    for (let i = 0; i < 12; i += 1) recordObservedBuild("codex", `0.1.${i}`, { path });
    const tally = readObservedBuilds({ path });
    expect(Object.keys(tally["codex"]?.builds ?? {})).toHaveLength(8);
    expect(tally["codex"]?.unversioned).toBe(4);
  });

  it("is owner-only on disk", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    recordObservedBuild("cursor", "3.15.6", { path });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
  });

  it("degrades to nothing observed when the file is corrupt, and clears cleanly", () => {
    sandbox = createSandbox();
    const path = tallyPath(sandbox);
    writeFileSync(path, "{not json");
    expect(readObservedBuilds({ path })).toEqual({});

    recordObservedBuild("cursor", "3.15.6", { path });
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
        claude_code: { builds: { "2.1.227": { count: 3, firstAt: 1, lastAt: 2 } }, unversioned: 0 },
        junk: { builds: { "not a version!": { count: 1, firstAt: 1, lastAt: 2 } }, unversioned: 0 },
      }),
    );
    const tally = readObservedBuilds({ path });
    expect(tally["claude_code"]?.builds["2.1.227"]?.count).toBe(3);
    expect(tally["junk"]).toBeUndefined();
  });
});
