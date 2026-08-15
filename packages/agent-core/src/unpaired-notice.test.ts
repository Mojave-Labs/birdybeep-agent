/**
 * The unpaired-activity notice (birdybeep-agent-gcgp.4): the durable half of the signal an
 * unpaired hook fire leaves behind, since the hot path has no one to talk to. Proven against a
 * hermetic temp HOME — bounded size, metadata only, and never throws into a hook.
 */
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { birdyBeepDataDir } from "./paths";
import {
  clearUnpairedNotice,
  readUnpairedNotice,
  recordUnpairedEvent,
  unpairedNoticePath,
} from "./unpaired-notice";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

const POSIX = process.platform !== "win32";

describe("unpaired-activity notice", () => {
  it("accumulates a count, a window, and the harnesses involved", () => {
    sandbox = createSandbox();
    let clock = 1_700_000_000_000;
    const at = (): number => clock;

    expect(readUnpairedNotice()).toBeNull(); // nothing until something is lost
    recordUnpairedEvent("claude_code", { now: at });
    clock += 60_000;
    recordUnpairedEvent("codex", { now: at });
    clock += 60_000;
    const third = recordUnpairedEvent("claude_code", { now: at });

    expect(third).toEqual({
      count: 3,
      firstAt: 1_700_000_000_000,
      lastAt: 1_700_000_120_000,
      harnesses: ["claude_code", "codex"], // deduped + sorted
    });
    expect(readUnpairedNotice()).toEqual(third); // durable across processes
  });

  it("resolves under the user DATA dir and holds no notification content (§15)", () => {
    sandbox = createSandbox();
    expect(unpairedNoticePath()).toBe(join(birdyBeepDataDir(), "unpaired-events.json"));
    recordUnpairedEvent("claude_code");
    const raw = readFileSync(unpairedNoticePath(), "utf8");
    expect(raw).not.toMatch(/title|body|cwd/);
    if (POSIX) expect(statSync(unpairedNoticePath()).mode & 0o077).toBe(0); // 0600
  });

  it("is bounded: the file cannot grow with the number of events or harnesses", () => {
    sandbox = createSandbox();
    for (let i = 0; i < 500; i++) recordUnpairedEvent(`harness_${i}`);
    const raw = readFileSync(unpairedNoticePath(), "utf8");
    expect(readUnpairedNotice()?.count).toBe(500);
    expect(readUnpairedNotice()?.harnesses).toHaveLength(16); // capped
    expect(raw.length).toBeLessThan(1024);
  });

  it("`pair` clearing it is idempotent, and a cleared notice reads back as null", () => {
    sandbox = createSandbox();
    recordUnpairedEvent("claude_code");
    clearUnpairedNotice();
    clearUnpairedNotice();
    expect(readUnpairedNotice()).toBeNull();
  });

  it("survives a corrupt file rather than throwing into the hot path", () => {
    sandbox = createSandbox();
    mkdirSync(birdyBeepDataDir(), { recursive: true, mode: 0o700 });
    writeFileSync(unpairedNoticePath(), "{not json", { mode: 0o600 });
    expect(readUnpairedNotice()).toBeNull();
    expect(recordUnpairedEvent("claude_code")?.count).toBe(1); // starts over, never throws
  });

  it("returns null (never throws) when the notice cannot be written", () => {
    sandbox = createSandbox();
    const dir = sandbox.path("readonly");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "unpaired-events.json");
    if (!POSIX) return; // POSIX mode bits only
    chmodSync(dir, 0o500); // no write permission
    try {
      expect(recordUnpairedEvent("claude_code", { path })).toBeNull();
    } finally {
      chmodSync(dir, 0o700); // so the sandbox can clean up
    }
  });
});
