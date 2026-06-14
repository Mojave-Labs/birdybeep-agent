/**
 * OC-INSTALL proof (hermetic temp HOME): empty HOME → opencode.json with the BirdyBeep
 * plugin entry + needs_restart + restart message; a realistic pre-existing config →
 * only the plugin entry added, all prior keys + a user plugin preserved, backup written;
 * double-install idempotent; no token written.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { BIRDYBEEP_PLUGIN_REF, installOpenCode, isBirdyBeepPluginConfigured } from "./install";
import { opencodeConfigFile } from "./paths";

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

function readConfig(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
function seed(home: string, value: unknown): string {
  const path = opencodeConfigFile({ home });
  mkdirSync(dirname(path), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, raw);
  return raw;
}

describe("install into an empty HOME", () => {
  it("creates opencode.json with the BirdyBeep plugin entry and returns needs_restart", async () => {
    sandbox = createSandbox();
    const path = opencodeConfigFile({ home: sandbox.home });
    const r = await installOpenCode({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.status).toBe("needs_restart");
    expect(r.requiredActions.join(" ")).toMatch(/[Rr]estart OpenCode/);
    expect(r.backupFiles).toEqual([]);

    const config = readConfig(path);
    expect(config["plugin"]).toEqual([BIRDYBEEP_PLUGIN_REF]);
    expect(isBirdyBeepPluginConfigured(config)).toBe(true);
  });
});

describe("install over a realistic pre-existing config", () => {
  it("adds only the BirdyBeep entry, preserves prior keys + a user plugin, and backs up", async () => {
    sandbox = createSandbox();
    const path = opencodeConfigFile({ home: sandbox.home });
    const original = seed(sandbox.home, {
      $schema: "https://opencode.ai/config.json",
      theme: "tokyonight",
      plugin: ["opencode-helicone-session"],
      model: "anthropic/claude-sonnet-4-6",
    });

    const r = await installOpenCode({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.backupFiles).toEqual([`${path}.birdybeep-backup`]);
    expect(readFileSync(`${path}.birdybeep-backup`, "utf8")).toBe(original); // byte-for-byte backup

    const config = readConfig(path);
    expect(config["theme"]).toBe("tokyonight");
    expect(config["model"]).toBe("anthropic/claude-sonnet-4-6");
    expect(config["$schema"]).toBe("https://opencode.ai/config.json");
    // The user's own plugin is preserved ALONGSIDE BirdyBeep's.
    expect(config["plugin"]).toEqual(["opencode-helicone-session", BIRDYBEEP_PLUGIN_REF]);
  });

  it("is idempotent — a second install produces an identical file", async () => {
    sandbox = createSandbox();
    const path = opencodeConfigFile({ home: sandbox.home });
    seed(sandbox.home, { theme: "dark", plugin: ["user-plugin"] });
    await installOpenCode({}, sandbox.home);
    const afterFirst = readFileSync(path, "utf8");
    const r2 = await installOpenCode({}, sandbox.home);
    expect(r2.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
  });
});

describe("security", () => {
  it("never writes a token; only the plugin reference appears", async () => {
    sandbox = createSandbox();
    const path = opencodeConfigFile({ home: sandbox.home });
    await installOpenCode({}, sandbox.home);
    const content = readFileSync(path, "utf8");
    expect(content).toContain(BIRDYBEEP_PLUGIN_REF);
    expect(content.toLowerCase()).not.toContain("bearer ");
    expect(content).not.toMatch(/bbm_|token["']?\s*[:=]\s*["']\S/i);
  });
});
