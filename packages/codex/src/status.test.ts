/**
 * CX-STATUS-DOCTOR proof (hermetic temp HOME): status() returns the correct §8.8 enum
 * for each fixture state — absent Codex → not_detected; Codex present, BirdyBeep absent
 * → unknown; installed-no-event → needs_trust; installed-with-event → installed;
 * malformed/partial config → error. doctor() flags each failure mode with the expected
 * remedy (incl. the /hooks trust hint and a missing machine token). Both are read-only:
 * the config tree is byte-identical after the calls.
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

import {
  backupPathFor,
  BIRDYBEEP_HOOK_EVENTS,
  installCodex,
  recordCodexMigration,
} from "./install";
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

  // birdybeep-agent-8kt: the corrupt-config check is the one failure `birdybeep agent install`
  // cannot repair by itself (install refuses to parse-then-write a file it can't read), so its
  // `→ fix` line has to name the real recovery steps — not just "re-run install".
  it("flags a malformed config.toml with a fix naming the file + install command", async () => {
    sandbox = createSandbox();
    seedConfig(sandbox.home, "= = bad [[[");
    const path = codexConfigFile({ home: sandbox.home });
    const r = await codexDoctor({ home: sandbox.home, detect: DETECTED, tokenOptions: FILE_ONLY });
    const valid = r.checks.find((c) => c.name === "config.toml is valid TOML");
    expect(valid?.ok).toBe(false);
    expect(valid?.remedy).toContain(path);
    expect(valid?.remedy).toContain("birdybeep agent install codex");
    // Branch-discriminating: the backup-branch string CONTAINS the config path, so without this
    // the no-backup case passes even if the ternary always took the backup branch.
    expect(valid?.remedy).not.toContain("birdybeep-backup");
  });

  it("points a malformed config.toml at the BirdyBeep backup when the installer left one", async () => {
    sandbox = createSandbox();
    // Install first (which backs up the pre-existing config), THEN corrupt it — the real shape
    // of "it worked, then something scrambled config.toml".
    seedConfig(sandbox.home, 'model = "o3"\n');
    await installCodex({}, sandbox.home);
    const path = codexConfigFile({ home: sandbox.home });
    const backupPath = backupPathFor(path);
    expect(existsSync(backupPath)).toBe(true);
    writeFileSync(path, "= = bad [[[");

    const r = await codexDoctor({ home: sandbox.home, detect: DETECTED, tokenOptions: FILE_ONLY });
    const valid = r.checks.find((c) => c.name === "config.toml is valid TOML");
    expect(valid?.ok).toBe(false);
    expect(valid?.remedy).toContain(backupPath);
    expect(valid?.remedy).toContain("birdybeep agent install codex");
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

/**
 * gcgp.9 parity (wired for gcgp.16): a hook command whose absolute paths have moved still reads
 * as fully installed while Codex fails it with exit 127 — the failure with no other symptom.
 */
describe("codexDoctor — hook command resolves", () => {
  /** A real install, then the launcher swapped for the one under test (what an upgrade leaves). */
  async function seedInstalled(home: string, command: string): Promise<void> {
    await installCodex({ home, hookCommand: command }, home);
  }

  it("passes when every path in the installed command still exists", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const node = sandbox.path("node");
    const cli = sandbox.path("birdybeep.cjs");
    writeFileSync(node, "");
    writeFileSync(cli, "");
    await seedInstalled(sandbox.home, `"${node}" "${cli}" hook codex`);
    const r = await codexDoctor({
      home: sandbox.home,
      detect: DETECTED,
      dataDir: sandbox.path("data"),
      tokenOptions: FILE_ONLY,
    });
    expect(r.checks.find((c) => c.name === "Hook command resolves")?.ok).toBe(true);
  });

  it("flags a moved CLI with the reinstall remedy", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const gone = sandbox.path("moved-away", "birdybeep.cjs");
    await seedInstalled(sandbox.home, `"${gone}" hook codex`);
    const r = await codexDoctor({
      home: sandbox.home,
      detect: DETECTED,
      dataDir: sandbox.path("data"),
      tokenOptions: FILE_ONLY,
    });
    const check = r.checks.find((c) => c.name === "Hook command resolves");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(gone);
    expect(check?.detail).toMatch(/exit 127/);
    expect(check?.remedy).toMatch(/birdybeep agent install codex/);
  });
});

/**
 * gcgp.15: an upgrade that rewrote the hook entries drops Codex's content-keyed trust, so
 * turn-complete beeps are OFF for someone whose Codex beeps worked yesterday. That must not read
 * like a first install.
 */
describe("codexDoctor — trust after a migration", () => {
  async function doctorFor(home: string, dataDir: string) {
    await installCodex({ home, dataDir }, home);
    return codexDoctor({ home, detect: DETECTED, dataDir, tokenOptions: FILE_ONLY });
  }

  it("reads as a first install when nothing was migrated", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const r = await doctorFor(sandbox.home, sandbox.path("data"));
    const check = r.checks.find((c) => c.name === "Codex hooks trusted");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/has not fired a trusted lifecycle hook yet/);
  });

  it("says completion notifications are disabled after an install migration", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const dataDir = sandbox.path("data");
    recordCodexMigration([...BIRDYBEEP_HOOK_EVENTS], { dataDir });
    const r = await doctorFor(sandbox.home, dataDir);
    const check = r.checks.find((c) => c.name === "Codex hooks trusted");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/completion notifications are disabled/i);
    expect(check?.remedy).toMatch(/\/hooks/);
  });

  it("self-clears once a genuinely trusted hook fires", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const dataDir = sandbox.path("data");
    recordCodexMigration([...BIRDYBEEP_HOOK_EVENTS], { dataDir });
    await installCodex({ home: sandbox.home, dataDir }, sandbox.home);
    recordCodexEventSeen({ dataDir });
    const r = await codexDoctor({
      home: sandbox.home,
      detect: DETECTED,
      dataDir,
      tokenOptions: FILE_ONLY,
    });
    expect(r.checks.find((c) => c.name === "Codex hooks trusted")?.ok).toBe(true);
  });
});
