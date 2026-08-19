/**
 * birdybeep-agent-gcgp.15 REGRESSION — the upgrade path, simulated end-to-end against an isolated
 * CODEX_HOME that reproduces a PREVIOUSLY-CONFIGURED user.
 *
 * The regression this pins: gcgp.2 moved Codex turn-complete off the single-slot `notify` program
 * onto `[[hooks.Stop]]`. `Stop` is a NEW hook key, and Codex trusts hooks by content hash — an
 * untrusted hook is skipped SILENTLY. So an existing user who upgrades and re-runs
 * `birdybeep agent install codex` has their old notify cleared (it was ours) while the new `Stop`
 * hook is untrusted: no turn-complete beeps, no error, no clue. Anyone whose notify was not
 * chained by a third party loses the signal outright.
 *
 * The trust gate itself is working as designed. What was missing is that install did not
 * DISTINGUISH a migration from a first install — where `needs_trust` is expected and the user is
 * already watching — nor keep telling them afterwards. Both are asserted here, including the
 * stale-trust-marker half: a marker recorded before these hashes changed no longer proves
 * anything, and leaving it made `status`/`doctor` claim "trusted" while Codex skipped the hooks.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { DetectionResult } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { parse } from "smol-toml";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codexMigrationRecorded,
  codexTurnCompleteIsDark,
  installCodex,
  MIGRATION_WARNING,
} from "./install";
import { codexConfigFile } from "./paths";
import { codexDoctor, codexStatus } from "./status";
import { hasCodexEventBeenSeen, recordCodexEventSeen } from "./trust";
import { uninstallCodex } from "./uninstall";

let sandbox: Sandbox | undefined;
const ORIGINAL = process.env["CODEX_HOME"];
beforeEach(() => delete process.env["CODEX_HOME"]);
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});
afterAll(() => {
  if (ORIGINAL !== undefined) process.env["CODEX_HOME"] = ORIGINAL;
});

const DETECTED = (): Promise<DetectionResult> => Promise.resolve({ detected: true });

/** The hook events an OLD BirdyBeep registered — `Stop` did NOT exist yet (gcgp.2 added it). */
const PRE_STOP_EVENTS = [
  "SessionStart",
  "PermissionRequest",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
];

/**
 * A config exactly as a pre-gcgp.2 BirdyBeep left it: our argv squatting the single `notify`
 * slot, plus the old (bare-command) hook set — and, optionally, the user's own unrelated keys.
 */
function seedPreviouslyConfigured(home: string, extra: string[] = []): string {
  const lines = ['notify = ["birdybeep", "hook", "codex"]', 'model = "gpt-5"', ...extra, ""];
  for (const event of PRE_STOP_EVENTS) {
    lines.push(
      `[[hooks.${event}]]`,
      'matcher = ""',
      "",
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      'command = "birdybeep hook codex"',
      "timeout = 10",
      "",
    );
  }
  const body = lines.join("\n");
  const path = codexConfigFile({ home });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return body;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readConfig(home: string): Record<string, unknown> {
  return asRecord(parse(readFileSync(codexConfigFile({ home }), "utf8")));
}

/** Set up the machine of a user who upgraded: old config on disk, old hooks already trusted. */
function upgradingUser(sb: Sandbox): { dataDir: string } {
  const dataDir = sb.path("data");
  seedPreviouslyConfigured(sb.home);
  recordCodexEventSeen({ dataDir }); // they granted trust long ago; beeps work today
  expect(hasCodexEventBeenSeen({ dataDir })).toBe(true);
  return { dataDir };
}

describe("gcgp.15: upgrading a previously-configured Codex user", () => {
  it("REPRO — before install, this machine is healthy: trusted, and reporting `installed`", () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const { dataDir } = upgradingUser(sb);
    // The pre-upgrade world: the old hook set is trusted, so nothing warns and nothing is dark.
    expect(hasCodexEventBeenSeen({ dataDir })).toBe(true);
    expect(codexTurnCompleteIsDark({ dataDir })).toBe(false);
    // …and yet there is no `Stop` hook at all, which is precisely what the upgrade adds.
    expect(asRecord(readConfig(sb.home)["hooks"])["Stop"]).toBeUndefined();
  });

  it("install announces the MIGRATION first — before the ordinary trust instructions", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const { dataDir } = upgradingUser(sb);

    const result = await installCodex({ dataDir }, sb.home);

    // Unmissable: the warning is the FIRST thing the CLI prints, not a footnote after the notes.
    expect(result.requiredActions.slice(0, MIGRATION_WARNING.length)).toEqual([
      ...MIGRATION_WARNING,
    ]);
    const text = result.requiredActions.join("\n");
    expect(text).toMatch(/turn-complete beeps are OFF/i);
    expect(text).toMatch(/\/hooks/);
    expect(result.status).toBe("needs_trust");
  });

  it("drops the now-meaningless trust marker, so status stops claiming `installed`", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const { dataDir } = upgradingUser(sb);

    await installCodex({ dataDir }, sb.home);

    // The marker predates the new hashes — keeping it would report "trusted" while Codex skips.
    expect(hasCodexEventBeenSeen({ dataDir })).toBe(false);
    expect(await codexStatus({ home: sb.home, dataDir, detect: DETECTED })).toBe("needs_trust");
    expect(codexMigrationRecorded({ dataDir })).toBe(true);
    expect(codexTurnCompleteIsDark({ dataDir })).toBe(true);
  });

  it("doctor keeps reporting it after the install output has scrolled away", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const { dataDir } = upgradingUser(sb);
    await installCodex({ dataDir }, sb.home);

    const report = await codexDoctor({ home: sb.home, dataDir, detect: DETECTED });
    const trust = report.checks.find((c) => c.name === "Codex hooks trusted");
    expect(trust?.ok).toBe(false);
    expect(trust?.status).toBe("needs_trust");
    expect(`${trust?.remedy}`).toMatch(/\/hooks/);
    // The dark predicate is what the CLI's doctor should headline (see the ticket hand-off).
    expect(codexTurnCompleteIsDark({ dataDir })).toBe(true);
  });

  it("the dark window CLOSES by itself once a trusted lifecycle hook actually fires", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const { dataDir } = upgradingUser(sb);
    await installCodex({ dataDir }, sb.home);
    expect(codexTurnCompleteIsDark({ dataDir })).toBe(true);

    // The user runs /hooks, and Codex fires a trust-gated hook: `runCodexHook` records this.
    recordCodexEventSeen({ dataDir });

    expect(codexTurnCompleteIsDark({ dataDir })).toBe(false);
    expect(await codexStatus({ home: sb.home, dataDir, detect: DETECTED })).toBe("installed");
    const report = await codexDoctor({ home: sb.home, dataDir, detect: DETECTED });
    expect(report.checks.find((c) => c.name === "Codex hooks trusted")?.ok).toBe(true);
  });

  it("registers `Stop` — the hook the whole migration exists to add", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const { dataDir } = upgradingUser(sb);
    await installCodex({ dataDir }, sb.home);

    const hooks = asRecord(readConfig(sb.home)["hooks"]);
    expect(Array.isArray(hooks["Stop"])).toBe(true);
    expect((hooks["Stop"] as unknown[]).length).toBe(1);
  });
});

describe("gcgp.15: a FIRST install is not a migration", () => {
  it("does not print the migration warning on a clean machine", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const dataDir = sb.path("data");

    const result = await installCodex({ dataDir }, sb.home);

    expect(result.status).toBe("needs_trust"); // still trust-gated, as always
    expect(result.requiredActions.join("\n")).not.toMatch(/beeps are OFF/i);
    expect(codexMigrationRecorded({ dataDir })).toBe(false);
    expect(codexTurnCompleteIsDark({ dataDir })).toBe(false);
  });

  it("does not print it into a config that only holds a THIRD PARTY's notify", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const dataDir = sb.path("data");
    const path = codexConfigFile({ home: sb.home });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'notify = ["user-notifier", "--flag"]\nmodel = "o3"\n');

    const result = await installCodex({ dataDir }, sb.home);

    expect(result.requiredActions.join("\n")).not.toMatch(/beeps are OFF/i);
    expect(codexMigrationRecorded({ dataDir })).toBe(false);
    // …and their notify is still theirs.
    expect(readConfig(sb.home)["notify"]).toEqual(["user-notifier", "--flag"]);
  });

  it("an idempotent re-run of an up-to-date install warns about nothing", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const dataDir = sb.path("data");
    await installCodex({ dataDir }, sb.home);
    recordCodexEventSeen({ dataDir }); // trusted and working

    const again = await installCodex({ dataDir }, sb.home);

    expect(again.changed).toBe(false); // nothing rewritten → no hashes invalidated
    expect(again.requiredActions.join("\n")).not.toMatch(/beeps are OFF/i);
    expect(hasCodexEventBeenSeen({ dataDir })).toBe(true); // trust NOT dropped gratuitously
  });
});

describe("gcgp.15: the legacy `notify` is still removed (the decision, pinned)", () => {
  it("vacates our own squatted slot rather than keeping it as a safety net", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const { dataDir } = upgradingUser(sb);

    await installCodex({ dataDir }, sb.home);

    // Ours is gone: it is a single-valued slot that belongs to whoever else wants it, the bare
    // command in it is the very thing gcgp.16 replaces, and there is no safe later moment to
    // remove it. The gap is covered by the warning above instead.
    expect(readConfig(sb.home)["notify"]).toBeUndefined();
    expect(codexTurnCompleteIsDark({ dataDir })).toBe(true); // …and we SAY so
  });

  it("hands a displaced third-party notify back to its owner from the backup", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const dataDir = sb.path("data");
    const path = codexConfigFile({ home: sb.home });
    mkdirSync(dirname(path), { recursive: true });
    // The user's original, captured as the canonical backup an older install left behind.
    writeFileSync(`${path}.birdybeep-backup`, 'notify = ["user-notifier", "--flag"]\n');
    seedPreviouslyConfigured(sb.home);
    recordCodexEventSeen({ dataDir });

    const result = await installCodex({ dataDir }, sb.home);

    expect(readConfig(sb.home)["notify"]).toEqual(["user-notifier", "--flag"]);
    expect(result.requiredActions.join("\n")).toMatch(/Restored the Codex `notify` program/);
    expect(result.requiredActions.join("\n")).toMatch(/beeps are OFF/i); // still a migration
  });
});

describe("gcgp.15: uninstall clears the migration state", () => {
  it("leaves nothing claiming a re-trust is owed", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const { dataDir } = upgradingUser(sb);
    await installCodex({ dataDir }, sb.home);
    expect(codexMigrationRecorded({ dataDir })).toBe(true);

    await uninstallCodex({ dataDir }, sb.home);

    expect(codexMigrationRecorded({ dataDir })).toBe(false);
    expect(codexTurnCompleteIsDark({ dataDir })).toBe(false);
  });
});
