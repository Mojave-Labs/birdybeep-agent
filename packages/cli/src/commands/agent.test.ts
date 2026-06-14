/**
 * `birdybeep agent install` proof (hermetic temp HOME): runs the REAL adapter installs for
 * `all` and for a single harness with deterministic detection. Asserts each modified config
 * is backed up, only BirdyBeep-managed entries are added (pre-existing content intact), the
 * configs invoke `birdybeep hook <harness>` (or the plugin ref for OpenCode) with NO token,
 * the changed-files + required-action output is correct, a second run is a no-op, and bad/
 * undetected targets are handled cleanly.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentAdapter } from "@birdybeep/agent-core";
import {
  BIRDYBEEP_HOOK_COMMAND as CLAUDE_HOOK,
  claudeCodeAdapter,
  claudeSettingsPath,
} from "@birdybeep/claude-code";
import {
  BIRDYBEEP_HOOK_COMMAND as CODEX_HOOK,
  codexAdapter,
  codexConfigFile,
} from "@birdybeep/codex";
import { BIRDYBEEP_PLUGIN_REF, opencodeAdapter, opencodeConfigFile } from "@birdybeep/opencode";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { EXIT } from "../framework";
import { createAgentCommand, selectAdapters } from "./agent";

let sandbox: Sandbox | undefined;
const ORIGINAL_CODEX_HOME = process.env["CODEX_HOME"];
beforeEach(() => delete process.env["CODEX_HOME"]);
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});
afterAll(() => {
  if (ORIGINAL_CODEX_HOME !== undefined) process.env["CODEX_HOME"] = ORIGINAL_CODEX_HOME;
});

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}

/** Force detection true so the REAL install runs deterministically under the temp HOME. */
function detected(adapter: AgentAdapter): AgentAdapter {
  return { ...adapter, detect: () => Promise.resolve({ detected: true, version: "test" }) };
}
function adapters(): AgentAdapter[] {
  return [detected(claudeCodeAdapter), detected(codexAdapter), detected(opencodeAdapter)];
}

function seed(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}
/** Seed a pre-existing user config for every harness so backups + preservation are exercised. */
function seedAll(home: string): void {
  seed(claudeSettingsPath(home), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
  seed(codexConfigFile({ home }), 'model = "o3"\n');
  seed(opencodeConfigFile({ home }), `${JSON.stringify({ theme: "tokyonight" }, null, 2)}\n`);
}

interface JsonResult {
  results: {
    harness: string;
    detected: boolean;
    status?: string;
    changedFiles?: string[];
    backupFiles?: string[];
    requiredActions?: string[];
  }[];
}

describe("agent install all", () => {
  it("installs every harness: backups, managed-only entries, hook invocation, no token", async () => {
    sandbox = createSandbox();
    const home = sandbox.home;
    seedAll(home);
    const out = capture();
    const code = await runCli(["agent", "install", "all", "--json"], {
      commands: [createAgentCommand({ adapters: adapters() })],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);

    const parsed = JSON.parse(out.text()) as JsonResult;
    const byId = Object.fromEntries(parsed.results.map((r) => [r.harness, r]));
    expect(byId["claude_code"]?.status).toBe("installed");
    expect(byId["codex"]?.status).toBe("needs_trust");
    expect(byId["opencode"]?.status).toBe("needs_restart");

    // Required actions surfaced: Codex /hooks trust + OpenCode restart.
    expect((byId["codex"]?.requiredActions ?? []).join(" ")).toMatch(/\/hooks/);
    expect((byId["opencode"]?.requiredActions ?? []).join(" ")).toMatch(/[Rr]estart OpenCode/);

    // Backups exist for every pre-existing config.
    for (const r of parsed.results) expect((r.backupFiles ?? []).length).toBeGreaterThan(0);

    // Configs invoke the hook (Claude/Codex) / plugin ref (OpenCode), preserve prior keys, no token.
    const claude = readFileSync(claudeSettingsPath(home), "utf8");
    expect(claude).toContain(CLAUDE_HOOK);
    expect(claude).toContain("dark"); // prior key preserved
    const codex = readFileSync(codexConfigFile({ home }), "utf8");
    expect(codex).toContain(CODEX_HOOK);
    expect(codex).toContain('"o3"'); // prior key preserved
    const opencode = readFileSync(opencodeConfigFile({ home }), "utf8");
    expect(opencode).toContain(BIRDYBEEP_PLUGIN_REF);
    expect(opencode).toContain("tokyonight"); // prior key preserved

    for (const content of [claude, codex, opencode]) {
      expect(content.toLowerCase()).not.toContain("bearer ");
      expect(content).not.toMatch(/bbm_|token["']?\s*[:=]\s*["']\S/i);
    }
  });

  it("is idempotent — a second `install all` leaves every config byte-identical", async () => {
    sandbox = createSandbox();
    const home = sandbox.home;
    seedAll(home);
    const cmd = createAgentCommand({ adapters: adapters() });
    const run = () =>
      runCli(["agent", "install", "all"], {
        commands: [cmd],
        stdout: capture().writer,
        stderr: capture().writer,
        ensureConfig: false,
      });
    await run();
    const after1 = [
      claudeSettingsPath(home),
      codexConfigFile({ home }),
      opencodeConfigFile({ home }),
    ].map((p) => readFileSync(p, "utf8"));
    await run();
    const after2 = [
      claudeSettingsPath(home),
      codexConfigFile({ home }),
      opencodeConfigFile({ home }),
    ].map((p) => readFileSync(p, "utf8"));
    expect(after2).toEqual(after1);
  });

  it("prints required actions + a per-harness line in human mode", async () => {
    sandbox = createSandbox();
    seedAll(sandbox.home);
    const out = capture();
    await runCli(["agent", "install", "all"], {
      commands: [createAgentCommand({ adapters: adapters() })],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    const text = out.text();
    expect(text).toContain("Claude Code");
    expect(text).toMatch(/\/hooks/); // Codex trust action
    expect(text).toMatch(/[Rr]estart OpenCode/); // OpenCode restart action
  });
});

describe("agent install <harness> + edge cases", () => {
  it("installs exactly the named harness and leaves the others untouched", async () => {
    sandbox = createSandbox();
    const home = sandbox.home;
    const out = capture();
    await runCli(["agent", "install", "codex", "--json"], {
      commands: [createAgentCommand({ adapters: adapters() })],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    const parsed = JSON.parse(out.text()) as JsonResult;
    expect(parsed.results.map((r) => r.harness)).toEqual(["codex"]);
    expect(existsSync(codexConfigFile({ home }))).toBe(true);
    expect(existsSync(claudeSettingsPath(home))).toBe(false); // others untouched
    expect(existsSync(opencodeConfigFile({ home }))).toBe(false);
  });

  it("reports an undetected harness cleanly (skipped, exit 0)", async () => {
    sandbox = createSandbox();
    const notThere: AgentAdapter = {
      ...codexAdapter,
      detect: () => Promise.resolve({ detected: false }),
    };
    const out = capture();
    const code = await runCli(["agent", "install", "codex", "--json"], {
      commands: [createAgentCommand({ adapters: [notThere] })],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(out.text()) as JsonResult;
    expect(parsed.results[0]).toMatchObject({ harness: "codex", detected: false });
  });

  it("rejects an unknown target with USAGE", async () => {
    sandbox = createSandbox();
    const out = capture();
    const code = await runCli(["agent", "install", "bogus"], {
      commands: [createAgentCommand({ adapters: adapters() })],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.USAGE);
    expect(out.text()).toContain('unknown target "bogus"');
  });

  it("selectAdapters maps targets to adapter ids", () => {
    const all = adapters();
    expect(selectAdapters("all", all)).toHaveLength(3);
    expect((selectAdapters("claude", all) as AgentAdapter[])[0]?.id).toBe("claude_code");
    expect((selectAdapters("codex", all) as AgentAdapter[])[0]?.id).toBe("codex");
    expect(selectAdapters("nope", all)).toBe("unknown");
  });
});

describe("agent uninstall", () => {
  it("install all → uninstall all restores every config byte-for-byte", async () => {
    sandbox = createSandbox();
    const home = sandbox.home;
    seedAll(home);
    const originals = [
      claudeSettingsPath(home),
      codexConfigFile({ home }),
      opencodeConfigFile({ home }),
    ].map((p) => readFileSync(p, "utf8"));

    const cmd = createAgentCommand({ adapters: adapters() });
    await runCli(["agent", "install", "all"], {
      commands: [cmd],
      stdout: capture().writer,
      stderr: capture().writer,
      ensureConfig: false,
    });

    const out = capture();
    const code = await runCli(["agent", "uninstall", "all", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    const restored = [
      claudeSettingsPath(home),
      codexConfigFile({ home }),
      opencodeConfigFile({ home }),
    ].map((p) => readFileSync(p, "utf8"));
    expect(restored).toEqual(originals); // byte-for-byte original (no BirdyBeep references)
    for (const c of restored) {
      expect(c).not.toContain(CLAUDE_HOOK);
      expect(c).not.toContain(BIRDYBEEP_PLUGIN_REF);
    }
  });

  it("is a no-op when nothing is installed (idempotent, exit 0)", async () => {
    sandbox = createSandbox();
    const out = capture();
    const code = await runCli(["agent", "uninstall", "all", "--json"], {
      commands: [createAgentCommand({ adapters: adapters() })],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(out.text()) as { results: { changed: boolean }[] };
    expect(parsed.results.every((r) => !r.changed)).toBe(true);
  });

  it("rejects an unknown uninstall target with USAGE", async () => {
    sandbox = createSandbox();
    const out = capture();
    const code = await runCli(["agent", "uninstall", "bogus"], {
      commands: [createAgentCommand({ adapters: adapters() })],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.USAGE);
  });
});
