/**
 * Self-demonstrating E2E: this proves the rig itself is sound (A-TEST-HARNESS).
 * It drives the reference adapter through the FULL cycle in a hermetic sandbox —
 * install over pre-existing config, fire a real-shaped Claude Code payload, and
 * assert the delivered event honors the privacy contract — then tears everything
 * down. When the real Claude Code adapter lands (CC-E2E), it swaps in for the
 * reference adapter and reuses every assertion below unchanged.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertDelivered,
  assertExactDeliveredCount,
  assertNoAbsolutePaths,
  assertNoRawValues,
  assertNoTokenInRepo,
  assertPathsHashed,
  assertRealHomeUntouched,
  assertTreeDelta,
  assertTreesEqual,
  assertTruncated,
  assertWithinSizeCap,
  captureTree,
  deliveredBearerToken,
  eventBody,
  findRepoRoot,
} from "./contract";
import {
  BACKUP_REL,
  BODY_TRUNCATE_AT,
  referenceAdapter,
  seedFileToken,
  SETTINGS_REL,
  TOKEN_REL,
} from "./example-adapter";
import { claudeCodeFixtures, FIXTURE_RAW_PATHS } from "./fixtures";
import { createSandbox, type Sandbox } from "./sandbox";
import { AGENT_EVENTS_PATH, type EventSink, StubEventSink } from "./sink";

// Generated at runtime, NOT a source literal — a hardcoded token would itself sit
// in this repo file and (correctly) trip assertNoTokenInRepo. Real tokens are
// runtime secrets, so this mirrors reality.
const TOKEN = `bb_machine_TESTONLY_${randomUUID()}`;

// Track what each test created so we can guarantee teardown even on failure.
let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;

afterEach(async () => {
  const home = sandbox?.home;
  sandbox?.cleanup();
  await sink?.close();
  // Sandbox must be gone after cleanup.
  if (home) expect(existsSync(home)).toBe(false);
  sandbox = undefined;
  sink = undefined;
});

describe("E2E harness rig (A-TEST-HARNESS self-demo)", () => {
  it("installs over existing config, fires a real payload, and asserts the full contract", async () => {
    sink = await StubEventSink.start();
    sandbox = createSandbox();
    const sb = sandbox;

    // Pre-existing FOREIGN Claude Code config the install must preserve + back up.
    const foreign = `${JSON.stringify({ theme: "dark", hooks: { PreToolUse: [{ matcher: "Bash" }] } }, null, 2)}\n`;
    const settingsPath = sb.path(SETTINGS_REL);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, foreign);

    // Token lives in the file-fallback store (no keychain on CI Linux/Windows).
    seedFileToken(sb, TOKEN);

    const claudeDir = sb.path(".claude");
    const beforeInstall = captureTree(claudeDir);

    // --- install: non-destructive, backs up, only managed entries added ---
    const install1 = referenceAdapter.install(sb);
    expect(install1.changed).toBe(true);
    expect(install1.backupPath).toBeDefined();
    const afterInstall = captureTree(claudeDir);
    assertTreeDelta(beforeInstall, afterInstall, {
      added: ["settings.json.birdybeep-backup"],
      changed: ["settings.json"],
    });
    // Backup is the original foreign config byte-for-byte.
    expect(readFileSync(sb.path(BACKUP_REL), "utf8")).toBe(foreign);

    // --- idempotency: a second install changes nothing ---
    const install2 = referenceAdapter.install(sb);
    expect(install2.changed).toBe(false);
    assertTreesEqual(afterInstall, captureTree(claudeDir), "second install must be a no-op");

    // --- fire a REAL-shaped Claude Code payload through the adapter (it gets only a URL) ---
    const payload = claudeCodeFixtures.notificationPermissionPrompt();
    const sent = await referenceAdapter.fire(payload, {
      endpoint: `${sink.url}${AGENT_EVENTS_PATH}`,
      sandbox: sb,
    });

    // --- assert the delivered event honors the contract ---
    assertExactDeliveredCount(sink, 1); // no stray/duplicate events
    const delivered = assertDelivered(sink, {
      eventType: "approval_required",
      harness: "claude_code",
      sourceSessionId: payload.session_id,
      path: AGENT_EVENTS_PATH,
    });
    assertWithinSizeCap(delivered);
    // Known sensitive values must never appear raw (scans body + headers)…
    assertPathsHashed(delivered, [...FIXTURE_RAW_PATHS, sb.home, sb.realHome]);
    // …and no absolute path of ANY shape may appear in the body (catches un-listed leaks).
    assertNoAbsolutePaths(delivered);
    // The over-long permission message must have been truncated.
    assertTruncated(delivered, "body", BODY_TRUNCATE_AT);
    expect((eventBody(delivered)["body"] as string).length).toBeLessThan(payload.message.length);
    // Token came from the file store and was sent as a Bearer — but never echoed in the body.
    expect(deliveredBearerToken(delivered)).toBe(TOKEN);
    assertNoRawValues(delivered, [TOKEN], { scope: "body" });
    expect(sent.event_type).toBe("approval_required");

    // --- token never written into any repo-local file ---
    assertNoTokenInRepo(findRepoRoot(process.cwd()), TOKEN);

    // --- the real user HOME was never touched (check uniquely-BirdyBeep artifacts: the
    // backup + token. The plain SETTINGS_REL legitimately pre-exists for a real Claude
    // Code user, so it is NOT a valid escape sentinel). ---
    assertRealHomeUntouched(sb.realHome, [BACKUP_REL, TOKEN_REL]);

    // --- uninstall restores the original foreign config byte-for-byte ---
    referenceAdapter.uninstall(sb);
    assertTreesEqual(beforeInstall, captureTree(claudeDir), "uninstall must restore byte-for-byte");
    expect(readFileSync(settingsPath, "utf8")).toBe(foreign);
  });
});
