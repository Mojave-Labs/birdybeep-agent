/**
 * CC-SNAPSHOT (§21.1 / §16.4): lock the EXACT Claude Code config BirdyBeep generates
 * and prove non-destructive patching against realistic settings.json shapes. If the
 * generator drifts or Claude Code's hook format changes, these committed snapshots
 * fail loudly. Deterministic config only — no live delivery (that's CC-E2E).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { installClaudeCode } from "./install";
import { claudeSettingsPath } from "./paths";
import { uninstallClaudeCode } from "./uninstall";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function seed(path: string, value: unknown): string {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, raw);
  return raw;
}
async function installAndRead(sb: Sandbox): Promise<string> {
  await installClaudeCode({}, sb.home);
  return readFileSync(claudeSettingsPath(sb.home), "utf8");
}
function expectNoSecrets(content: string): void {
  expect(content.toLowerCase()).not.toContain("bearer ");
  expect(content).not.toMatch(/bbm_|token["']?\s*[:=]\s*["']\S/i);
}

describe("generated config snapshots (§21.1)", () => {
  it("from-scratch install writes the canonical BirdyBeep hook block", async () => {
    sandbox = createSandbox();
    const out = await installAndRead(sandbox);
    expect(out).toMatchSnapshot();
    expectNoSecrets(out);
  });

  it("patches into an existing config with a same-event Stop hook + permissions", async () => {
    sandbox = createSandbox();
    seed(claudeSettingsPath(sandbox.home), {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "my-own-stop-hook" }] }] },
    });
    const out = await installAndRead(sandbox);
    expect(out).toMatchSnapshot();
    expectNoSecrets(out);
  });

  it("patches into an existing config with MCP servers + other keys", async () => {
    sandbox = createSandbox();
    seed(claudeSettingsPath(sandbox.home), {
      theme: "dark",
      mcpServers: {
        memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
      },
    });
    const out = await installAndRead(sandbox);
    expect(out).toMatchSnapshot();
    expectNoSecrets(out);
  });

  it("double-install is idempotent (second output identical to first)", async () => {
    sandbox = createSandbox();
    const first = await installAndRead(sandbox);
    await installClaudeCode({}, sandbox.home);
    expect(readFileSync(claudeSettingsPath(sandbox.home), "utf8")).toBe(first);
  });

  it("install → uninstall returns to the original fixture byte-for-byte", async () => {
    sandbox = createSandbox();
    const original = seed(claudeSettingsPath(sandbox.home), {
      theme: "dark",
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "my-own-stop-hook" }] }] },
    });
    await installClaudeCode({}, sandbox.home);
    await uninstallClaudeCode({}, sandbox.home);
    expect(readFileSync(claudeSettingsPath(sandbox.home), "utf8")).toBe(original);
  });
});
