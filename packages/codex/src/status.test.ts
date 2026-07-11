/**
 * CX-STATUS-DOCTOR proof (hermetic temp HOME): status() returns the correct §8.8 enum
 * for each fixture state — absent Codex → not_detected; Codex present, BirdyBeep absent
 * → unknown; installed-no-event → needs_trust; installed-with-event → installed;
 * malformed/partial config → error. doctor() flags each failure mode with the expected
 * remedy (incl. the /hooks trust hint and a missing machine token). Both are read-only:
 * the config tree is byte-identical after the calls.
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

import { installCodex } from "./install";
import { codexConfigFile } from "./paths";
import { codexDoctor, codexStatus } from "./status";
import { recordCodexEventSeen } from "./trust";

const FILE_ONLY = { backend: unavailableKeychainBackend };
const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const DETECTED: () => Promise<DetectionResult> = () => Promise.resolve({ detected: true });
const ABSENT: () => Promise<DetectionResult> = () => Promise.resolve({ detected: false });

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

function seedConfig(home: string, body: string): void {
  const path = codexConfigFile({ home });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

describe("codexStatus — §8.8 enum per fixture state", () => {
  it("absent Codex → not_detected", async () => {
    sandbox = createSandbox();
    expect(await codexStatus({ home: sandbox.home, detect: ABSENT })).toBe("not_detected");
  });

  it("Codex present, BirdyBeep not installed → unknown", async () => {
    sandbox = createSandbox();
    seedConfig(sandbox.home, 'model = "o3"\n'); // a Codex config with no BirdyBeep entries
    expect(await codexStatus({ home: sandbox.home, detect: DETECTED })).toBe("unknown");
  });

  it("installed but no event seen → needs_trust", async () => {
    sandbox = createSandbox();
    await installCodex({}, sandbox.home);
    expect(await codexStatus({ home: sandbox.home, detect: DETECTED })).toBe("needs_trust");
  });

  it("installed and a real event seen → installed", async () => {
    sandbox = createSandbox();
    await installCodex({}, sandbox.home);
    recordCodexEventSeen(); // simulate the trust transition (CX-TRUST)
    expect(await codexStatus({ home: sandbox.home, detect: DETECTED })).toBe("installed");
  });

  it("malformed config.toml → error", async () => {
    sandbox = createSandbox();
    seedConfig(sandbox.home, "this is = = not valid toml [[[");
    expect(await codexStatus({ home: sandbox.home, detect: DETECTED })).toBe("error");
  });

  it("partial install (notify managed, hooks missing) → error", async () => {
    sandbox = createSandbox();
    seedConfig(sandbox.home, 'notify = ["birdybeep", "hook", "codex"]\n');
    expect(await codexStatus({ home: sandbox.home, detect: DETECTED })).toBe("error");
  });
});

describe("codexDoctor — actionable diagnoses", () => {
  it("flags absent Codex with an install remedy", async () => {
    sandbox = createSandbox();
    const r = await codexDoctor({ home: sandbox.home, detect: ABSENT, tokenOptions: FILE_ONLY });
    expect(r.ok).toBe(false);
    const codexCheck = r.checks.find((c) => c.name === "Codex installed");
    expect(codexCheck?.ok).toBe(false);
    expect(codexCheck?.remedy).toMatch(/Install Codex/);
  });

  it("flags an untrusted (installed-no-event) Codex with the /hooks remedy", async () => {
    sandbox = createSandbox();
    await installCodex({}, sandbox.home);
    await setToken(TOKEN, FILE_ONLY);
    const r = await codexDoctor({ home: sandbox.home, detect: DETECTED, tokenOptions: FILE_ONLY });
    const trust = r.checks.find((c) => c.name === "Codex hooks trusted");
    expect(trust?.ok).toBe(false);
    expect(trust?.status).toBe("needs_trust");
    expect(trust?.remedy).toMatch(/\/hooks/);
  });

  it("flags a malformed config.toml", async () => {
    sandbox = createSandbox();
    seedConfig(sandbox.home, "= = bad [[[");
    const r = await codexDoctor({ home: sandbox.home, detect: DETECTED, tokenOptions: FILE_ONLY });
    const valid = r.checks.find((c) => c.name === "config.toml is valid TOML");
    expect(valid?.ok).toBe(false);
    expect(valid?.remedy).toMatch(/malformed/);
  });

  it("flags a missing machine token with a pair remedy", async () => {
    sandbox = createSandbox();
    await installCodex({}, sandbox.home);
    recordCodexEventSeen();
    // No token set → the token check fails.
    const r = await codexDoctor({ home: sandbox.home, detect: DETECTED, tokenOptions: FILE_ONLY });
    const token = r.checks.find((c) => c.name === "Machine token present");
    expect(token?.ok).toBe(false);
    expect(token?.remedy).toMatch(/birdybeep pair/);
  });

  it("reports all-ok for an installed, trusted, token-paired, writable config", async () => {
    sandbox = createSandbox();
    await installCodex({}, sandbox.home);
    recordCodexEventSeen();
    await setToken(TOKEN, FILE_ONLY);
    const r = await codexDoctor({ home: sandbox.home, detect: DETECTED, tokenOptions: FILE_ONLY });
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });
});

describe("read-only invariant", () => {
  it("neither status() nor doctor() mutate the Codex config", async () => {
    sandbox = createSandbox();
    await installCodex({}, sandbox.home);
    await setToken(TOKEN, FILE_ONLY);
    const before = captureTree(dirname(codexConfigFile({ home: sandbox.home })));
    await codexStatus({ home: sandbox.home, detect: DETECTED, tokenOptions: FILE_ONLY });
    await codexDoctor({ home: sandbox.home, detect: DETECTED, tokenOptions: FILE_ONLY });
    const after = captureTree(dirname(codexConfigFile({ home: sandbox.home })));
    assertTreesEqual(before, after);
  });
});
