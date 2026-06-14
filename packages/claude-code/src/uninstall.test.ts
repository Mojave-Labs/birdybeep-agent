/**
 * CC-UNINSTALL proof (hermetic temp HOME): install→uninstall returns a realistic
 * config byte-for-byte to its original; a co-existing user hook is preserved while
 * BirdyBeep's is removed; a from-scratch install leaves no residue; and uninstall
 * with nothing installed (and a repeat) is a clean no-op.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  assertTreesEqual,
  captureTree,
  createSandbox,
  type Sandbox,
} from "@birdybeep/test-harness";
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

describe("install → uninstall is a clean, byte-for-byte revert", () => {
  it("restores a realistic pre-existing config exactly, preserving a user hook", async () => {
    sandbox = createSandbox();
    const settings = claudeSettingsPath(sandbox.home);
    const original = {
      theme: "dark",
      permissions: { allow: ["Bash(npm test)"] },
      mcpServers: {
        memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
      },
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "my-own-stop-hook" }] }] },
    };
    const originalRaw = seed(settings, original);
    const before = captureTree(sandbox.path(".claude"));

    await installClaudeCode({}, sandbox.home);
    const r = await uninstallClaudeCode({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.restoredFiles).toEqual([settings]);

    // Byte-for-byte back to the original, and the user's Stop hook survived intact.
    expect(readFileSync(settings, "utf8")).toBe(originalRaw);
    assertTreesEqual(
      before,
      captureTree(sandbox.path(".claude")),
      "uninstall restores the original",
    );
    expect(existsSync(`${settings}.birdybeep-backup`)).toBe(false); // backup consumed
  });
});

describe("from-scratch install leaves no residue", () => {
  it("removes the settings file BirdyBeep created", async () => {
    sandbox = createSandbox();
    const settings = claudeSettingsPath(sandbox.home);
    await installClaudeCode({}, sandbox.home); // creates settings.json from scratch
    expect(existsSync(settings)).toBe(true);
    const r = await uninstallClaudeCode({}, sandbox.home);
    expect(r.removedFiles).toEqual([settings]);
    expect(existsSync(settings)).toBe(false); // no orphan BirdyBeep block
  });
});

describe("idempotent no-op", () => {
  it("uninstall with nothing installed is a clean no-op", async () => {
    sandbox = createSandbox();
    const r = await uninstallClaudeCode({}, sandbox.home);
    expect(r).toEqual({ changed: false, removedFiles: [], restoredFiles: [] });
  });

  it("a second uninstall after a real uninstall is a no-op", async () => {
    sandbox = createSandbox();
    seed(claudeSettingsPath(sandbox.home), { theme: "dark" });
    await installClaudeCode({}, sandbox.home);
    await uninstallClaudeCode({}, sandbox.home);
    const second = await uninstallClaudeCode({}, sandbox.home);
    expect(second.changed).toBe(false);
  });

  it("does not touch a config with no BirdyBeep entries", async () => {
    sandbox = createSandbox();
    const settings = claudeSettingsPath(sandbox.home);
    const raw = seed(settings, {
      theme: "dark",
      hooks: { Stop: [{ hooks: [{ command: "other" }] }] },
    });
    const r = await uninstallClaudeCode({}, sandbox.home);
    expect(r.changed).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(raw); // untouched
  });
});
