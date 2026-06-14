/**
 * Dedup ledger proof: a repeated identity within the window is a duplicate; it falls
 * out after the window; distinct identities are independent; strict perms; fail-open.
 */
import { statSync } from "node:fs";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DEDUP_WINDOW_MS, eventIdentity, RecentEventLedger } from "./dedup";

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
    expect(ledger.markAndCheck("claude_code:s1:approval_required")).toBe(false); // new
    expect(ledger.markAndCheck("claude_code:s1:approval_required")).toBe(true); // duplicate
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
    expect(ledger.markAndCheck("claude_code:s1:approval_required")).toBe(false);
    expect(ledger.markAndCheck("claude_code:s1:agent_failed")).toBe(false); // different type
    expect(ledger.markAndCheck("claude_code:s2:approval_required")).toBe(false); // different session
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
  it("is harness:session:event_type", () => {
    expect(
      eventIdentity({
        harness: "claude_code",
        source_session_id: "s1",
        event_type: "approval_required",
      }),
    ).toBe("claude_code:s1:approval_required");
  });
});
