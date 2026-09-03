/**
 * Per-surface coverage rows in `birdybeep doctor` (birdybeep-agent-gcgp.6).
 *
 * The question these rows answer is the one config presence cannot: a harness's builds SHARE one
 * config file, so "hooks installed" is a single fact about all of them, and a desktop app whose
 * engine never reaches the hook looks exactly like one that does. Coverage is therefore graded on
 * OBSERVED EVENTS — the `harness_version` each build reports (gcgp.7) — and a build only counts
 * as a fault once a SIBLING build of the same harness is delivering and it still is not.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  type AgentAdapter,
  createSender,
  type DetectionResult,
  type HarnessSurface,
  type IntegrationStatus,
  recordObservedBuild,
  setToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { EXIT } from "../framework";
import { createDoctorCommand } from "./doctor";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}

const CONFIG = "/home/dev/.claude/settings.json";

function surface(
  id: string,
  kind: "terminal" | "desktop",
  label: string,
  version?: string,
): HarnessSurface {
  return {
    id,
    kind,
    label,
    ...(version !== undefined ? { version } : {}),
    enginePath: `/engines/${id}`,
    configPath: CONFIG,
  };
}

/** Claude Code as this machine really has it: one terminal build, one desktop build, one config. */
function claudeWith(status: IntegrationStatus, surfaces: HarnessSurface[]): AgentAdapter {
  const detection: DetectionResult = { detected: true, configPath: CONFIG, surfaces };
  return {
    id: "claude_code",
    displayName: "Claude Code",
    detect: () => Promise.resolve(detection),
    status: () => Promise.resolve(status),
    doctor: () =>
      Promise.resolve({ ok: true, checks: [{ name: "BirdyBeep hooks installed", ok: true }] }),
  } as AgentAdapter;
}

const TERMINAL = surface("terminal", "terminal", "terminal CLI", "2.1.227");
const DESKTOP = surface("desktop", "desktop", "Claude desktop app", "2.1.229");

interface DoctorJson {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string; remedy?: string }[];
}

async function runDoctor(
  adapter: AgentAdapter,
  observedPath: string,
): Promise<{ code: number; json: DoctorJson; text: string }> {
  const cmd = createDoctorCommand({
    adapters: [adapter],
    createSender: () => createSender({ baseUrl: "http://127.0.0.1:1", tokenOptions: FILE_ONLY }),
    tokenOptions: FILE_ONLY,
    probeNetwork: () => Promise.resolve(true),
    surfaceOptions: { observedBuilds: { path: observedPath } },
  });
  const out = capture();
  const code = await runCli(["doctor", "--json"], {
    commands: [cmd],
    stdout: out.writer,
    stderr: out.writer,
    ensureConfig: false,
  });
  return { code, json: JSON.parse(out.text()) as DoctorJson, text: out.text() };
}

function byName(json: DoctorJson): Record<string, DoctorJson["checks"][number]> {
  return Object.fromEntries(json.checks.map((c) => [c.name, c]));
}

describe("doctor per-surface coverage", () => {
  it("gives the terminal and desktop builds their own rows, with their own versions", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const { code, json } = await runDoctor(
      claudeWith("installed", [TERMINAL, DESKTOP]),
      join(sandbox.home, "observed.json"),
    );

    const rows = byName(json);
    expect(rows["Claude Code: terminal CLI 2.1.227"]).toBeDefined();
    expect(rows["Claude Code: Claude desktop app 2.1.229"]).toBeDefined();
    // Nothing has fired from EITHER build yet, so neither is at fault — a fresh install is not
    // a failure, and doctor must not go red on every machine that has just run install.
    expect(rows["Claude Code: terminal CLI 2.1.227"]?.ok).toBe(true);
    expect(rows["Claude Code: Claude desktop app 2.1.229"]?.ok).toBe(true);
    expect(rows["Claude Code: Claude desktop app 2.1.229"]?.detail).toMatch(/nothing has fired/);
    expect(code).toBe(EXIT.OK);
  });

  it("fails only the build that has never fired, while the delivering one stays green", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const path = join(sandbox.home, "observed.json");
    recordObservedBuild(
      "claude_code",
      { version: "2.1.227", surface: "terminal" },
      { path, now: () => 1_760_000_000_000 },
    );
    recordObservedBuild(
      "claude_code",
      { version: "2.1.227", surface: "terminal" },
      { path, now: () => 1_760_000_060_000 },
    );

    const { code, json } = await runDoctor(claudeWith("installed", [TERMINAL, DESKTOP]), path);
    const rows = byName(json);

    const terminal = rows["Claude Code: terminal CLI 2.1.227"];
    expect(terminal?.ok).toBe(true);
    expect(terminal?.detail).toMatch(/covered: 2 event\(s\) from this build/);

    const desktop = rows["Claude Code: Claude desktop app 2.1.229"];
    expect(desktop?.ok).toBe(false);
    expect(desktop?.detail).toMatch(/nothing has fired from this build/);
    expect(desktop?.detail).toContain("terminal CLI 2.1.227");
    // The remedy names the real failure mode: a desktop app spawns its engine with the LOGIN
    // shell's PATH, so a bare `birdybeep` in the hook entry is invisible to it.
    expect(desktop?.remedy).toMatch(/LOGIN shell's PATH/);
    expect(desktop?.remedy).toMatch(/birdybeep agent install claude/);
    expect(code).toBe(EXIT.ERROR);
  });

  it("attributes an observed build to the one surface whose version is unreadable", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const path = join(sandbox.home, "observed.json");
    recordObservedBuild(
      "claude_code",
      { version: "0.148.0-alpha.9", surface: "desktop" },
      { path },
    );
    // The ChatGPT-bundled Codex shape: a surface the filesystem cannot version.
    const bundled = surface("desktop", "desktop", "ChatGPT desktop app");
    const { json } = await runDoctor(claudeWith("installed", [bundled]), path);
    const row = byName(json)["Claude Code: ChatGPT desktop app 0.148.0-alpha.9"];
    expect(row?.ok).toBe(true);
    expect(row?.detail).toMatch(/covered: 1 event\(s\)/);
  });

  it("marks every build uncovered when the harness carries no BirdyBeep hooks, without a duplicate fix", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const { code, json } = await runDoctor(
      claudeWith("unknown", [TERMINAL, DESKTOP]),
      join(sandbox.home, "observed.json"),
    );
    const rows = byName(json);
    for (const name of [
      "Claude Code: terminal CLI 2.1.227",
      "Claude Code: Claude desktop app 2.1.229",
    ]) {
      expect(rows[name]?.ok).toBe(false);
      expect(rows[name]?.detail).toMatch(/carries no BirdyBeep hooks/);
      // The adapter's own "hooks installed" check owns that fix; doctor must not print it twice.
      expect(rows[name]?.remedy).toBeUndefined();
    }
    expect(code).toBe(EXIT.ERROR);
  });

  it("never blames a SHADOWED install for not firing — the user cannot run it", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const path = join(sandbox.home, "observed.json");
    recordObservedBuild("claude_code", { version: "2.1.227", surface: "terminal" }, { path });
    const shadowed: HarnessSurface = {
      ...surface("terminal-2", "terminal", "terminal CLI (shadowed on PATH)", "2.1.220"),
      shadowed: true,
    };
    const { code, json } = await runDoctor(claudeWith("installed", [TERMINAL, shadowed]), path);
    const row = byName(json)["Claude Code: terminal CLI (shadowed on PATH) 2.1.220"];
    expect(row?.ok).toBe(true);
    expect(row?.detail).toMatch(/another install comes first on PATH/);
    expect(code).toBe(EXIT.OK);
  });

  it("gives a desktop build the login-PATH remedy and a terminal build a different one", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const path = join(sandbox.home, "observed.json");
    recordObservedBuild("claude_code", { version: "2.1.229", surface: "desktop" }, { path });
    const { json } = await runDoctor(claudeWith("installed", [TERMINAL, DESKTOP]), path);
    const terminal = byName(json)["Claude Code: terminal CLI 2.1.227"];
    expect(terminal?.ok).toBe(false);
    expect(terminal?.remedy).not.toMatch(/LOGIN shell's PATH/);
    expect(terminal?.remedy).toContain("/engines/terminal");
  });

  it("adds no rows for a harness that is not installed at all", async () => {
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const absent = claudeWith("not_detected", []);
    const notDetected: DetectionResult = { detected: false, surfaces: [] };
    const { json } = await runDoctor(
      { ...absent, detect: () => Promise.resolve(notDetected) },
      join(sandbox.home, "observed.json"),
    );
    // The adapter's own checks still print; what must not appear is any per-BUILD row.
    const surfaceRows = json.checks.filter(
      (c) => c.name.includes("terminal CLI") || c.name.includes("desktop app"),
    );
    expect(surfaceRows).toHaveLength(0);
  });
});
