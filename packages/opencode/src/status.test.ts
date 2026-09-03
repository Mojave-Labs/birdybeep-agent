/**
 * OC-STATUS-DOCTOR proof (hermetic temp HOME): status() returns the correct §8.8 enum for
 * each fixture state — absent OpenCode → not_detected; present but plugin absent → unknown;
 * configured-no-event → needs_restart; configured-with-event → installed; malformed config
 * → error. doctor() flags each failure mode with the expected remedy (incl. the restart
 * hint and a missing token). Both are read-only: the config tree is byte-identical after.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type DetectionResult, setToken, unavailableKeychainBackend } from "@birdybeep/agent-core";
import {
  assertTreesEqual,
  captureTree,
  createSandbox,
  type Sandbox,
} from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { backupPathFor, installOpenCode, opencodeLauncherPath } from "./install";
import { opencodeConfigFile } from "./paths";
import { recordOpenCodeEventSeen } from "./restart";
import { opencodeDoctor, opencodeStatus } from "./status";

const FILE_ONLY = { backend: unavailableKeychainBackend };
const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const DETECTED: () => Promise<DetectionResult> = () => Promise.resolve({ detected: true });
const ABSENT: () => Promise<DetectionResult> = () => Promise.resolve({ detected: false });

let sandbox: Sandbox | undefined;
const ORIGINAL_XDG = process.env["XDG_CONFIG_HOME"];
beforeEach(() => delete process.env["XDG_CONFIG_HOME"]);
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});
afterAll(() => {
  if (ORIGINAL_XDG !== undefined) process.env["XDG_CONFIG_HOME"] = ORIGINAL_XDG;
});

function seed(home: string, body: string): void {
  const path = opencodeConfigFile({ home });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

describe("opencodeStatus — §8.8 enum per fixture state", () => {
  it("absent OpenCode → not_detected", async () => {
    sandbox = createSandbox();
    expect(await opencodeStatus({ home: sandbox.home, detect: ABSENT })).toBe("not_detected");
  });

  it("OpenCode present, BirdyBeep plugin not configured → unknown", async () => {
    sandbox = createSandbox();
    seed(sandbox.home, JSON.stringify({ theme: "dark" }));
    expect(await opencodeStatus({ home: sandbox.home, detect: DETECTED })).toBe("unknown");
  });

  it("plugin configured but no event seen → needs_restart", async () => {
    sandbox = createSandbox();
    await installOpenCode({}, sandbox.home);
    expect(await opencodeStatus({ home: sandbox.home, detect: DETECTED })).toBe("needs_restart");
  });

  it("plugin configured and a real event seen → installed", async () => {
    sandbox = createSandbox();
    await installOpenCode({}, sandbox.home);
    recordOpenCodeEventSeen(); // simulate the restart transition
    expect(await opencodeStatus({ home: sandbox.home, detect: DETECTED })).toBe("installed");
  });

  it("malformed opencode.json → error", async () => {
    sandbox = createSandbox();
    seed(sandbox.home, "{ not valid json ]");
    expect(await opencodeStatus({ home: sandbox.home, detect: DETECTED })).toBe("error");
  });
});

describe("opencodeDoctor — actionable diagnoses", () => {
  it("flags absent OpenCode with an install remedy", async () => {
    sandbox = createSandbox();
    const r = await opencodeDoctor({ home: sandbox.home, detect: ABSENT, tokenOptions: FILE_ONLY });
    expect(r.ok).toBe(false);
    const check = r.checks.find((c) => c.name === "OpenCode installed");
    expect(check?.ok).toBe(false);
    expect(check?.remedy).toMatch(/Install OpenCode/);
  });

  it("flags a configured-but-not-restarted OpenCode with the restart remedy", async () => {
    sandbox = createSandbox();
    await installOpenCode({}, sandbox.home);
    await setToken(TOKEN, FILE_ONLY);
    const r = await opencodeDoctor({
      home: sandbox.home,
      detect: DETECTED,
      tokenOptions: FILE_ONLY,
    });
    const loaded = r.checks.find((c) => c.name === "OpenCode plugin loaded");
    expect(loaded?.ok).toBe(false);
    expect(loaded?.status).toBe("needs_restart");
    expect(loaded?.remedy).toMatch(/[Rr]estart OpenCode/);
  });

  // birdybeep-agent-8kt: the corrupt-config check is the one failure `birdybeep agent install`
  // cannot repair by itself (install refuses to parse-then-write a file it can't read), so its
  // `→ fix` line has to name the real recovery steps — not just "re-run install".
  it("flags a malformed opencode.json with a fix naming the file + install command", async () => {
    sandbox = createSandbox();
    seed(sandbox.home, "{ bad json");
    const path = opencodeConfigFile({ home: sandbox.home });
    const r = await opencodeDoctor({
      home: sandbox.home,
      detect: DETECTED,
      tokenOptions: FILE_ONLY,
    });
    const valid = r.checks.find((c) => c.name === "opencode.json is valid JSON");
    expect(valid?.ok).toBe(false);
    expect(valid?.remedy).toContain(path);
    expect(valid?.remedy).toContain("birdybeep agent install opencode");
    // Branch-discriminating: the backup-branch string CONTAINS the config path, so without this
    // the no-backup case passes even if the ternary always took the backup branch.
    expect(valid?.remedy).not.toContain("birdybeep-backup");
  });

  it("points a malformed opencode.json at the BirdyBeep backup when the installer left one", async () => {
    sandbox = createSandbox();
    // Install first (which backs up the pre-existing config), THEN corrupt it — the real shape
    // of "it worked, then something scrambled opencode.json".
    seed(sandbox.home, `${JSON.stringify({ theme: "opencode" }, null, 2)}\n`);
    await installOpenCode({}, sandbox.home);
    const path = opencodeConfigFile({ home: sandbox.home });
    const backupPath = backupPathFor(path);
    expect(existsSync(backupPath)).toBe(true);
    writeFileSync(path, "{ bad json");

    const r = await opencodeDoctor({
      home: sandbox.home,
      detect: DETECTED,
      tokenOptions: FILE_ONLY,
    });
    const valid = r.checks.find((c) => c.name === "opencode.json is valid JSON");
    expect(valid?.ok).toBe(false);
    expect(valid?.remedy).toContain(backupPath);
    expect(valid?.remedy).toContain("birdybeep agent install opencode");
  });

  it("flags a missing machine token with a pair remedy", async () => {
    sandbox = createSandbox();
    await installOpenCode({}, sandbox.home);
    recordOpenCodeEventSeen();
    const r = await opencodeDoctor({
      home: sandbox.home,
      detect: DETECTED,
      tokenOptions: FILE_ONLY,
    });
    const token = r.checks.find((c) => c.name === "Machine token present");
    expect(token?.ok).toBe(false);
    expect(token?.remedy).toMatch(/birdybeep pair/);
  });

  it("reports all-ok for an installed, loaded, token-paired, writable config", async () => {
    sandbox = createSandbox();
    await installOpenCode({}, sandbox.home);
    recordOpenCodeEventSeen();
    await setToken(TOKEN, FILE_ONLY);
    const r = await opencodeDoctor({
      home: sandbox.home,
      detect: DETECTED,
      tokenOptions: FILE_ONLY,
    });
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });
});

describe("read-only invariant", () => {
  it("neither status() nor doctor() mutate the OpenCode config", async () => {
    sandbox = createSandbox();
    await installOpenCode({}, sandbox.home);
    await setToken(TOKEN, FILE_ONLY);
    const before = captureTree(dirname(opencodeConfigFile({ home: sandbox.home })));
    await opencodeStatus({ home: sandbox.home, detect: DETECTED, tokenOptions: FILE_ONLY });
    await opencodeDoctor({ home: sandbox.home, detect: DETECTED, tokenOptions: FILE_ONLY });
    const after = captureTree(dirname(opencodeConfigFile({ home: sandbox.home })));
    assertTreesEqual(before, after);
  });
});

/**
 * gcgp.16: OpenCode alone writes no command into harness config — install records an absolute
 * launcher argv the plugin spawns directly. That record is the artifact `doctor` must inspect,
 * and its failure modes are unlike exit 127: a missing record silently falls back to a PATH
 * lookup, a stale one names a CLI that has moved.
 */
describe("opencodeDoctor — plugin launcher", () => {
  const LAUNCHER = "Plugin launcher resolves";

  function launcherRecord(dataDir: string, argv: string[]): void {
    const path = opencodeLauncherPath({ dataDir });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ argv }));
  }

  async function doctorWith(home: string, dataDir: string) {
    await installOpenCode({ home, dataDir });
    return opencodeDoctor({ home, detect: DETECTED, dataDir, tokenOptions: FILE_ONLY });
  }

  it("passes when the recorded launcher still exists", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const dataDir = sandbox.path("data");
    const node = sandbox.path("node");
    const cli = sandbox.path("birdybeep.cjs");
    writeFileSync(node, "");
    writeFileSync(cli, "");
    await installOpenCode({ home: sandbox.home, dataDir });
    launcherRecord(dataDir, [node, cli]);
    const r = await opencodeDoctor({
      home: sandbox.home,
      detect: DETECTED,
      dataDir,
      tokenOptions: FILE_ONLY,
    });
    expect(r.checks.find((c) => c.name === LAUNCHER)?.ok).toBe(true);
  });

  it("flags a stale launcher naming the path that moved", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const dataDir = sandbox.path("data");
    const node = sandbox.path("node");
    writeFileSync(node, "");
    const gone = sandbox.path("moved-away", "birdybeep.cjs");
    await installOpenCode({ home: sandbox.home, dataDir });
    launcherRecord(dataDir, [node, gone]);
    const r = await opencodeDoctor({
      home: sandbox.home,
      detect: DETECTED,
      dataDir,
      tokenOptions: FILE_ONLY,
    });
    const check = r.checks.find((c) => c.name === LAUNCHER);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(gone);
    expect(check?.remedy).toMatch(/birdybeep agent install opencode/);
  });

  it("flags a missing launcher on a machine that has never delivered — the silent-drop suspect", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const dataDir = sandbox.path("data");
    const r = await doctorWith(sandbox.home, dataDir);
    const check = r.checks.find((c) => c.name === LAUNCHER);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/failed lookup drops the event/);
  });

  it("does not call a missing launcher an error while events are arriving", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const dataDir = sandbox.path("data");
    await installOpenCode({ home: sandbox.home, dataDir });
    recordOpenCodeEventSeen({ dataDir });
    const r = await opencodeDoctor({
      home: sandbox.home,
      detect: DETECTED,
      dataDir,
      tokenOptions: FILE_ONLY,
    });
    const check = r.checks.find((c) => c.name === LAUNCHER);
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/It is working here/);
  });
});
