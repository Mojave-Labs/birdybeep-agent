/**
 * OC-SNAPSHOT (§21.1 / §16.4): lock the EXACT opencode.json BirdyBeep generates and prove
 * non-destructive patching against realistic pre-existing configs. If the generator drifts
 * or the plugin entry changes, these committed snapshots fail loudly. Deterministic config
 * only — the generated JSON carries no machine paths, timestamps, or tokens — so snapshots
 * are stable across machines. No live delivery (that's OC-E2E).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { installOpenCode } from "./install";
import { opencodeConfigFile } from "./paths";
import { uninstallOpenCode } from "./uninstall";

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

function seed(home: string, value: unknown): string {
  const path = opencodeConfigFile({ home });
  mkdirSync(dirname(path), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, raw);
  return raw;
}
async function installAndRead(sb: Sandbox): Promise<string> {
  await installOpenCode({}, sb.home);
  return readFileSync(opencodeConfigFile({ home: sb.home }), "utf8");
}
function expectNoSecrets(content: string): void {
  expect(content.toLowerCase()).not.toContain("bearer ");
  expect(content).not.toMatch(/bbm_|token["']?\s*[:=]\s*["']\S/i);
}

describe("generated OpenCode config snapshots (§21.1)", () => {
  it("from-scratch install writes the canonical plugin block", async () => {
    sandbox = createSandbox();
    const out = await installAndRead(sandbox);
    expect(out).toMatchSnapshot();
    expectNoSecrets(out);
  });

  it("patches into a config with a user plugin + $schema + other keys", async () => {
    sandbox = createSandbox();
    seed(sandbox.home, {
      $schema: "https://opencode.ai/config.json",
      theme: "tokyonight",
      plugin: ["opencode-helicone-session"],
      model: "anthropic/claude-sonnet-4-6",
    });
    const out = await installAndRead(sandbox);
    expect(out).toMatchSnapshot();
    expectNoSecrets(out);
  });

  it("double-install is idempotent (second output identical to first)", async () => {
    sandbox = createSandbox();
    const first = await installAndRead(sandbox);
    await installOpenCode({}, sandbox.home);
    expect(readFileSync(opencodeConfigFile({ home: sandbox.home }), "utf8")).toBe(first);
  });

  it("install → uninstall returns to the original fixture byte-for-byte", async () => {
    sandbox = createSandbox();
    const original = seed(sandbox.home, {
      theme: "dark",
      plugin: ["user-plugin"],
      keybinds: { leader: "ctrl+x" },
    });
    await installOpenCode({}, sandbox.home);
    await uninstallOpenCode({}, sandbox.home);
    expect(readFileSync(opencodeConfigFile({ home: sandbox.home }), "utf8")).toBe(original);
  });
});
