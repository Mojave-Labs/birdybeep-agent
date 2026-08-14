/**
 * CX-INSTALL proof (hermetic temp HOME): empty HOME → minimal valid config.toml with
 * the BirdyBeep hook block; realistic pre-existing config.toml → only BB entries added,
 * all prior keys preserved, a user hook kept alongside ours, backup written;
 * double-install idempotent; status needs_trust + trust message; no token. Plus the
 * gcgp.2 regressions: another tool's `notify` is never taken, and a `notify` an older
 * BirdyBeep took is handed back.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { parse } from "smol-toml";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BACKUP_SUFFIX,
  BIRDYBEEP_HOOK_COMMAND,
  BIRDYBEEP_HOOK_EVENTS,
  installCodex,
  isBirdyBeepHookEntry,
  LEGACY_BIRDYBEEP_NOTIFY,
} from "./install";
import { codexConfigFile } from "./paths";

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

function readConfig(path: string): Record<string, unknown> {
  return parse(readFileSync(path, "utf8"));
}
function hookEntries(config: Record<string, unknown>, event: string): unknown[] {
  const hooks = config["hooks"];
  const list =
    typeof hooks === "object" && hooks !== null
      ? (hooks as Record<string, unknown>)[event]
      : undefined;
  return Array.isArray(list) ? list : [];
}

describe("install into an empty HOME", () => {
  it("creates config.toml with the BirdyBeep hook block and returns needs_trust", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    const r = await installCodex({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.status).toBe("needs_trust");
    expect(r.requiredActions.join(" ")).toMatch(/\/hooks/); // one-time trust instruction
    expect(r.backupFiles).toEqual([]);

    const config = readConfig(path);
    expect(config["notify"]).toBeUndefined(); // notify is not a BirdyBeep-managed slot
    for (const event of BIRDYBEEP_HOOK_EVENTS) {
      expect(hookEntries(config, event).some(isBirdyBeepHookEntry)).toBe(true);
    }
    expect(BIRDYBEEP_HOOK_EVENTS).toContain("Stop"); // turn-complete signal (gcgp.8)
  });
});

describe("install over a realistic pre-existing config.toml", () => {
  const seed = [
    'model = "o3"',
    'approval_policy = "on-request"',
    "",
    "[sandbox]",
    'mode = "workspace-write"',
    "",
    "[[hooks.PostToolUse]]",
    'matcher = "Bash"',
    "",
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    'command = "my-own-codex-hook"',
    "",
  ].join("\n");

  it("adds only BirdyBeep entries, preserves prior keys + a user hook, and backs up", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seed);

    const r = await installCodex({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.backupFiles).toEqual([`${path}.birdybeep-backup`]);
    // Backup is the original bytes.
    expect(readFileSync(`${path}.birdybeep-backup`, "utf8")).toBe(seed);

    const config = readConfig(path);
    // Prior keys preserved.
    expect(config["model"]).toBe("o3");
    expect(config["approval_policy"]).toBe("on-request");
    expect(config["sandbox"]).toEqual({ mode: "workspace-write" });
    // The user's PostToolUse hook is preserved ALONGSIDE BirdyBeep's.
    const postToolUse = hookEntries(config, "PostToolUse");
    expect(postToolUse.some((e) => JSON.stringify(e).includes("my-own-codex-hook"))).toBe(true);
    expect(postToolUse.some(isBirdyBeepHookEntry)).toBe(true);
    for (const event of BIRDYBEEP_HOOK_EVENTS) {
      expect(hookEntries(config, event).some(isBirdyBeepHookEntry)).toBe(true);
    }
  });

  it("is idempotent — a second install produces an identical file", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seed);
    await installCodex({}, sandbox.home);
    const afterFirst = readFileSync(path, "utf8");
    const r2 = await installCodex({}, sandbox.home);
    expect(r2.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
  });
});

/**
 * birdybeep-agent-gcgp.2 regression. Codex `notify` is a SINGLE-SLOT scalar (unlike the
 * append-only `[[hooks.X]]` arrays), so whoever writes last wins. The installer used to
 * ASSIGN it, which silently destroyed a third party's integration — observed on the owner's
 * own machine, where `config.toml.birdybeep-backup` proves Codex Computer Use owned the slot
 * first. Turn-complete now rides the `[[hooks.Stop]]` array instead (birdybeep-agent-gcgp.8),
 * so BirdyBeep never writes `notify` at all.
 */
describe("third-party notify is never destroyed (gcgp.2)", () => {
  const THIRD_PARTY = ["/Applications/OtherTool.app/Contents/MacOS/OtherToolClient", "turn-ended"];
  const seedWithForeignNotify = [
    'model = "o3"',
    `notify = ${JSON.stringify(THIRD_PARTY)}`,
    "",
  ].join("\n");

  it("leaves another tool's notify byte-identical while installing our hooks", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seedWithForeignNotify);

    const r = await installCodex({}, sandbox.home);
    expect(r.changed).toBe(true);

    const config = readConfig(path);
    // The third party still owns the slot, unchanged.
    expect(config["notify"]).toEqual(THIRD_PARTY);
    // …and our turn-complete signal is installed anyway, on the append-only hooks array.
    expect(hookEntries(config, "Stop").some(isBirdyBeepHookEntry)).toBe(true);
  });

  it("reports the notify program it left alone instead of silently overwriting it", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seedWithForeignNotify);

    const r = await installCodex({}, sandbox.home);
    const said = r.requiredActions.join("\n");
    expect(said).toContain("notify");
    expect(said).toContain("OtherToolClient"); // names exactly what is in the slot
  });

  it("removes its own LEGACY notify when there is nothing to give the slot back to", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    mkdirSync(dirname(path), { recursive: true });
    // A config written by an older BirdyBeep: the notify slot is ours, and the backup shows
    // BirdyBeep created the file (no displaced program to restore).
    writeFileSync(path, `notify = ${JSON.stringify([...LEGACY_BIRDYBEEP_NOTIFY])}\nmodel = "o3"\n`);

    const r = await installCodex({}, sandbox.home);
    expect(r.changed).toBe(true);
    const config = readConfig(path);
    expect(config["notify"]).toBeUndefined();
    expect(config["model"]).toBe("o3");
    expect(hookEntries(config, "Stop").some(isBirdyBeepHookEntry)).toBe(true);
  });

  /**
   * The migration must UNDO the old installer's damage, not complete it. On the owner's real
   * machine the canonical backup (2026-07-01) still holds the third party's original `notify`
   * that an older BirdyBeep overwrote. Vacating the slot instead of restoring it would delete
   * that program for good — the very bug this ticket exists to fix, one step later.
   */
  it("RESTORES the notify an older BirdyBeep displaced, rather than vacating the slot", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    mkdirSync(dirname(path), { recursive: true });
    // Live config: an old BirdyBeep owns the slot. Canonical backup: what it displaced.
    writeFileSync(path, `notify = ${JSON.stringify([...LEGACY_BIRDYBEEP_NOTIFY])}\nmodel = "o3"\n`);
    writeFileSync(
      `${path}${BACKUP_SUFFIX}`,
      `notify = ${JSON.stringify(THIRD_PARTY)}\nmodel = "o3"\n`,
    );

    const r = await installCodex({}, sandbox.home);
    expect(r.changed).toBe(true);

    const config = readConfig(path);
    expect(config["notify"]).toEqual(THIRD_PARTY); // given back, not deleted
    expect(hookEntries(config, "Stop").some(isBirdyBeepHookEntry)).toBe(true);
    const said = r.requiredActions.join("\n");
    expect(said).toContain("OtherToolClient"); // the user is told it came back
  });

  /**
   * `join(" ")` collapses argument boundaries, so a foreign value whose tokens happen to
   * concatenate to ours was misread as BirdyBeep's and deleted.
   */
  it("does not mistake a differently-split foreign notify for its own", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    mkdirSync(dirname(path), { recursive: true });
    const lookalike = ["birdybeep hook", "codex"]; // joins to "birdybeep hook codex"
    writeFileSync(path, `notify = ${JSON.stringify(lookalike)}\n`);

    await installCodex({}, sandbox.home);
    expect(readConfig(path)["notify"]).toEqual(lookalike); // not ours → untouched
  });

  /**
   * The compounding data-loss bug: the backup was written exactly ONCE, so a second install
   * over a config that had changed since (a third party re-claiming the slot) overwrote the
   * live value AND left a stale backup — unrecoverable. Every overwrite must be recoverable.
   */
  it("keeps a recoverable copy of a value the third party set AFTER the first install", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, seedWithForeignNotify);

    await installCodex({}, sandbox.home); // first install → canonical backup of the original
    expect(readFileSync(`${path}.birdybeep-backup`, "utf8")).toBe(seedWithForeignNotify);

    // The third party re-claims the slot with a NEW, chained value — the state the owner's
    // machine is actually in. It exists only in the live file; the backup predates it.
    const chained = [...THIRD_PARTY, "--previous-notify", '["birdybeep","hook","codex"]'];
    const raw = readFileSync(path, "utf8");
    const reclaimed = raw.includes("notify = ")
      ? raw.replace(/^notify = .*$/m, `notify = ${JSON.stringify(chained)}`)
      : `notify = ${JSON.stringify(chained)}\n${raw}`;
    writeFileSync(path, reclaimed);

    await installCodex({}, sandbox.home);

    // Their CURRENT value must still be reachable: live in the file, or in some backup.
    const marker = "--previous-notify";
    const stillLive = readFileSync(path, "utf8").includes(marker);
    const recoverable = readdirSync(dir)
      .filter((f) => f.includes(".birdybeep-backup"))
      .some((f) => readFileSync(join(dir, f), "utf8").includes(marker));
    expect(stillLive || recoverable).toBe(true);
    // …and the canonical backup still holds the true pre-BirdyBeep original.
    expect(readFileSync(`${path}.birdybeep-backup`, "utf8")).toBe(seedWithForeignNotify);
  });
});

describe("security", () => {
  it("never writes a token; only the command reference appears", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    await installCodex({}, sandbox.home);
    const content = readFileSync(path, "utf8");
    expect(content).toContain(BIRDYBEEP_HOOK_COMMAND);
    expect(content.toLowerCase()).not.toContain("bearer ");
    expect(content).not.toMatch(/bbm_|token["']?\s*[:=]\s*["']\S/i);
  });
});
