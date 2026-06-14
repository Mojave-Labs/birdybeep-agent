/**
 * OC-STATUS-DOCTOR proof (hermetic temp HOME): status() returns the correct §8.8 enum for
 * each fixture state — absent OpenCode → not_detected; present but plugin absent → unknown;
 * configured-no-event → needs_restart; configured-with-event → installed; malformed config
 * → error. doctor() flags each failure mode with the expected remedy (incl. the restart
 * hint and a missing token). Both are read-only: the config tree is byte-identical after.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type DetectionResult, setToken, unavailableKeychainBackend } from "@birdybeep/agent-core";
import {
  assertTreesEqual,
  captureTree,
  createSandbox,
  type Sandbox,
} from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { installOpenCode } from "./install";
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

  it("flags a malformed opencode.json", async () => {
    sandbox = createSandbox();
    seed(sandbox.home, "{ bad json");
    const r = await opencodeDoctor({
      home: sandbox.home,
      detect: DETECTED,
      tokenOptions: FILE_ONLY,
    });
    const valid = r.checks.find((c) => c.name === "opencode.json is valid JSON");
    expect(valid?.ok).toBe(false);
    expect(valid?.remedy).toMatch(/malformed/);
  });

  it("flags a missing machine token with a login remedy", async () => {
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
    expect(token?.remedy).toMatch(/birdybeep login/);
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
