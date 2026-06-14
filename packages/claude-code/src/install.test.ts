/**
 * CC-INSTALL proof (hermetic temp HOME): empty HOME → minimal valid config with the
 * BirdyBeep hook block; realistic pre-existing config → only BB entries added, all
 * prior keys preserved, a user Stop hook kept alongside ours, backup byte-for-byte;
 * double-install idempotent; no token ever written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  assertTreeDelta,
  assertTreesEqual,
  captureTree,
  createSandbox,
  type Sandbox,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { installClaudeCode } from "./install";
import { BIRDYBEEP_HOOK_COMMAND, BIRDYBEEP_HOOK_EVENTS, isBirdyBeepEntry } from "./install";
import { claudeSettingsPath } from "./paths";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
function entriesFor(settings: Record<string, unknown>, event: string): unknown[] {
  const hooks = settings["hooks"];
  const list =
    typeof hooks === "object" && hooks !== null
      ? (hooks as Record<string, unknown>)[event]
      : undefined;
  return Array.isArray(list) ? list : [];
}
function seedSettings(path: string, value: unknown): string {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, raw);
  return raw;
}

describe("install into an empty HOME", () => {
  it("creates a minimal valid settings.json with exactly the BirdyBeep hook block", async () => {
    sandbox = createSandbox();
    const settings = claudeSettingsPath(sandbox.home);
    const r = await installClaudeCode({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.changedFiles).toEqual([settings]);
    expect(r.backupFiles).toEqual([]); // nothing pre-existing to back up
    expect(r.status).toBe("installed");

    const parsed = readSettings(settings);
    for (const event of BIRDYBEEP_HOOK_EVENTS) {
      expect(entriesFor(parsed, event).some(isBirdyBeepEntry)).toBe(true);
    }
  });
});

describe("install over realistic pre-existing config", () => {
  it("adds only BirdyBeep entries, preserves all prior keys + a user hook, and backs up", async () => {
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
    const originalRaw = seedSettings(settings, original);
    const before = captureTree(sandbox.path(".claude"));

    const r = await installClaudeCode({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.backupFiles).toEqual([`${settings}.birdybeep-backup`]);

    // Only BB-managed entries added at the file level: settings changed + backup added.
    assertTreeDelta(before, captureTree(sandbox.path(".claude")), {
      added: ["settings.json.birdybeep-backup"],
      changed: ["settings.json"],
    });
    // Backup is the original bytes, exactly.
    expect(readFileSync(`${settings}.birdybeep-backup`, "utf8")).toBe(originalRaw);

    const parsed = readSettings(settings);
    // All unrelated keys preserved untouched.
    expect(parsed["theme"]).toBe("dark");
    expect(parsed["permissions"]).toEqual(original.permissions);
    expect(parsed["mcpServers"]).toEqual(original.mcpServers);
    // The user's own Stop hook is preserved ALONGSIDE BirdyBeep's.
    const stop = entriesFor(parsed, "Stop");
    expect(stop.some((e) => JSON.stringify(e).includes("my-own-stop-hook"))).toBe(true);
    expect(stop.some(isBirdyBeepEntry)).toBe(true);
    // All four real hook events now carry a BirdyBeep entry.
    for (const event of BIRDYBEEP_HOOK_EVENTS) {
      expect(entriesFor(parsed, event).some(isBirdyBeepEntry)).toBe(true);
    }
  });

  it("is idempotent — a second install changes nothing", async () => {
    sandbox = createSandbox();
    const settings = claudeSettingsPath(sandbox.home);
    seedSettings(settings, { theme: "dark" });
    await installClaudeCode({}, sandbox.home);
    const afterFirst = captureTree(sandbox.path(".claude"));
    const r2 = await installClaudeCode({}, sandbox.home);
    expect(r2.changed).toBe(false);
    assertTreesEqual(afterFirst, captureTree(sandbox.path(".claude")), "second install is a no-op");
  });
});

describe("security", () => {
  it("never writes a token; the hook references the command which reads the token at runtime", async () => {
    sandbox = createSandbox();
    const settings = claudeSettingsPath(sandbox.home);
    await installClaudeCode({}, sandbox.home);
    const content = readFileSync(settings, "utf8");
    expect(content).toContain(BIRDYBEEP_HOOK_COMMAND);
    expect(content.toLowerCase()).not.toContain("bearer ");
    expect(content).not.toMatch(/bbm_|token["']?\s*[:=]\s*["']\S/i);
    expect(existsSync(settings)).toBe(true);
  });
});
