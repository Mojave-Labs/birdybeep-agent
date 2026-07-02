/**
 * Dedup ledger proof: a repeated identity within the window is a duplicate; it falls
 * out after the window; distinct identities are independent; identity is content-aware
 * (same type + different body ≠ duplicate — erm); the approval-collapse window is
 * narrower than the default; strict perms; fail-open.
 */
import { statSync } from "node:fs";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import {
  APPROVAL_COLLAPSE_WINDOW_MS,
  approvalCollapseIdentity,
  DEFAULT_DEDUP_WINDOW_MS,
  eventIdentity,
  RecentEventLedger,
} from "./dedup";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

const POSIX = process.platform !== "win32";

describe("RecentEventLedger.markAndCheck", () => {
  it("treats a fresh identity as new, then a repeat as a duplicate", () => {
    sandbox = createSandbox();
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "recent.json") });
    expect(ledger.markAndCheck("claude_code:s1:approval_required:abc")).toBe(false); // new
    expect(ledger.markAndCheck("claude_code:s1:approval_required:abc")).toBe(true); // duplicate
  });

  it("expires entries after the window", () => {
    sandbox = createSandbox();
    let t = 1_000;
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json"), now: () => t });
    expect(ledger.markAndCheck("id")).toBe(false);
    t += DEFAULT_DEDUP_WINDOW_MS + 1; // past the window
    expect(ledger.markAndCheck("id")).toBe(false); // no longer a duplicate
  });

  it("keeps distinct identities independent", () => {
    sandbox = createSandbox();
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json") });
    expect(ledger.markAndCheck("claude_code:s1:approval_required:h1")).toBe(false);
    expect(ledger.markAndCheck("claude_code:s1:agent_failed:h1")).toBe(false); // different type
    expect(ledger.markAndCheck("claude_code:s2:approval_required:h1")).toBe(false); // different session
  });

  it("honors a narrower per-call window without evicting longer-window entries", () => {
    sandbox = createSandbox();
    let t = 1_000;
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json"), now: () => t });
    expect(ledger.markAndCheck("approval:any", APPROVAL_COLLAPSE_WINDOW_MS)).toBe(false);
    t += APPROVAL_COLLAPSE_WINDOW_MS + 1; // past the SHORT window, inside the default one
    // The same id is no longer a duplicate under the short window (a second, distinct
    // approval a few seconds later must beep)…
    expect(ledger.markAndCheck("approval:any", APPROVAL_COLLAPSE_WINDOW_MS)).toBe(false);
    // …while a default-window identity recorded at the same time is still deduped.
    ledger.markAndCheck("content:id");
    t += APPROVAL_COLLAPSE_WINDOW_MS + 1;
    expect(ledger.markAndCheck("content:id")).toBe(true);
  });

  it("persists across instances (separate hook processes share the on-disk ledger)", () => {
    sandbox = createSandbox();
    const path = sandbox.path("data", "r.json");
    expect(new RecentEventLedger({ path }).markAndCheck("x")).toBe(false);
    expect(new RecentEventLedger({ path }).markAndCheck("x")).toBe(true); // second "process" sees it
  });

  it("writes the ledger with strict 0600 perms", () => {
    if (!POSIX) return;
    sandbox = createSandbox();
    const ledger = new RecentEventLedger({ path: sandbox.path("data", "r.json") });
    ledger.markAndCheck("x");
    expect(statSync(ledger.path).mode & 0o777).toBe(0o600);
    expect(ledger.isSecure()).toBe(true);
  });
});

describe("eventIdentity", () => {
  const base = {
    harness: "claude_code",
    source_session_id: "s1",
    event_type: "needs_input",
    title: "Claude Code needs input",
    body: "Which file should I edit?",
  };

  it("is harness:session:event_type:contentHash (content rides as a hash, never text)", () => {
    const id = eventIdentity(base);
    expect(id).toMatch(/^claude_code:s1:needs_input:[0-9a-f]{16}$/);
    expect(id).not.toContain("Which file"); // §15.2: no notification text in the ledger
  });

  it("differs when the content differs (distinct beeps of one type must both send — erm)", () => {
    const a = eventIdentity(base);
    const b = eventIdentity({ ...base, body: "Which BRANCH should I use?" });
    expect(a).not.toBe(b);
  });

  it("is stable for identical content (the true duplicate still collapses)", () => {
    expect(eventIdentity(base)).toBe(eventIdentity({ ...base }));
  });
});

describe("approvalCollapseIdentity", () => {
  it("is content-blind and type-pinned (pairs the permission double-fire)", () => {
    expect(approvalCollapseIdentity({ harness: "claude_code", source_session_id: "s1" })).toBe(
      "claude_code:s1:approval_required:any",
    );
  });
});
