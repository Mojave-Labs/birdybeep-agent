/**
 * Regression proof for the two ways per-surface coverage can INVERT itself and report a build
 * that has never run the hook as covered (birdybeep-agent-gcgp.6 review).
 *
 * Both come from keying observations by VERSION alone. The whole feature is the assertion at the
 * bottom of each case: a desktop build that has never fired must read `uncovered` while a
 * terminal build is delivering. Neither case existed, which is why both shipped past a green suite.
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
import { createDoctorCommand } from "./doctor";

const TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };
const CONFIG = "/home/dev/.claude/settings.json";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}

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

function harnessWith(surfaces: HarnessSurface[]): AgentAdapter {
  const detection: DetectionResult = { detected: true, configPath: CONFIG, surfaces };
  const stub: Partial<AgentAdapter> = {
    id: "claude_code",
    displayName: "Claude Code",
    detect: () => Promise.resolve(detection),
    status: () => Promise.resolve("installed" as IntegrationStatus),
    doctor: () => Promise.resolve({ ok: true, checks: [] }),
  };
  return stub as AgentAdapter;
}

interface DoctorJson {
  checks: { name: string; ok: boolean; detail?: string }[];
}

async function doctorRows(
  adapter: AgentAdapter,
  observedPath: string,
): Promise<Record<string, { name: string; ok: boolean; detail?: string }>> {
  const cmd = createDoctorCommand({
    adapters: [adapter],
    createSender: () => createSender({ baseUrl: "http://127.0.0.1:1", tokenOptions: FILE_ONLY }),
    tokenOptions: FILE_ONLY,
    probeNetwork: () => Promise.resolve(true),
    surfaceOptions: { observedBuilds: { path: observedPath } },
  });
  const out = capture();
  await runCli(["doctor", "--json"], {
    commands: [cmd],
    stdout: out.writer,
    stderr: out.writer,
    ensureConfig: false,
  });
  const json = JSON.parse(out.text()) as DoctorJson;
  return Object.fromEntries(json.checks.map((c) => [c.name, c]));
}

describe("surface attribution cannot report an unfired build as covered", () => {
  it("does not let a desktop build claim a terminal build's SAME version", async () => {
    // Both channels shipped 2.1.229. The terminal build fires; the desktop build cannot run the
    // hook at all. Keyed by version alone, one entry served both rows and the desktop went green.
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const path = join(sandbox.home, "observed.json");
    recordObservedBuild("claude_code", { version: "2.1.229", surface: "terminal" }, { path });

    const rows = await doctorRows(
      harnessWith([
        surface("terminal", "terminal", "terminal CLI", "2.1.229"),
        surface("desktop", "desktop", "Claude desktop app", "2.1.229"),
      ]),
      path,
    );

    expect(rows["Claude Code: terminal CLI 2.1.229"]?.ok).toBe(true);
    expect(rows["Claude Code: Claude desktop app 2.1.229"]?.ok).toBe(false);
    expect(rows["Claude Code: Claude desktop app 2.1.229"]?.detail).toMatch(/not covered/);
  });

  it("does not let a versionless desktop surface inherit a terminal build's retired version", async () => {
    // The terminal CLI fired at 0.147.0, then upgraded to 0.148.0 and fired again. Nothing reports
    // 0.147.0 any more, so it is the only unclaimed observation — and the ChatGPT-bundled build,
    // whose version cannot be read off disk, used to adopt it and report itself covered.
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const path = join(sandbox.home, "observed.json");
    recordObservedBuild("claude_code", { version: "0.147.0", surface: "terminal" }, { path });
    recordObservedBuild("claude_code", { version: "0.148.0", surface: "terminal" }, { path });

    const rows = await doctorRows(
      harnessWith([
        surface("terminal", "terminal", "terminal CLI", "0.148.0"),
        surface("desktop", "desktop", "ChatGPT desktop app"),
      ]),
      path,
    );

    expect(rows["Claude Code: terminal CLI 0.148.0"]?.ok).toBe(true);
    const desktop = rows["Claude Code: ChatGPT desktop app"];
    expect(desktop).toBeDefined();
    expect(desktop?.ok).toBe(false);
    expect(desktop?.detail).toMatch(/not covered/);
  });

  it("still attributes a versionless surface to an observation from ITS OWN kind", async () => {
    // The ChatGPT-bundled build keeps its version inside the binary, so a desktop-attributed
    // observation is the only thing that can name it — that must keep working.
    sandbox = createSandbox();
    await setToken(TOKEN, FILE_ONLY);
    const path = join(sandbox.home, "observed.json");
    recordObservedBuild(
      "claude_code",
      { version: "0.148.0-alpha.9", surface: "desktop" },
      { path },
    );

    const rows = await doctorRows(
      harnessWith([surface("desktop", "desktop", "ChatGPT desktop app")]),
      path,
    );
    expect(rows["Claude Code: ChatGPT desktop app 0.148.0-alpha.9"]?.ok).toBe(true);
  });
});
