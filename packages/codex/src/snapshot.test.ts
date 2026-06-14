/**
 * CX-SNAPSHOT (§21.1 / §16.4): lock the EXACT Codex config.toml BirdyBeep generates and
 * prove non-destructive patching against realistic pre-existing configs (unrelated keys,
 * differing key orders, a user hook, a user single-valued notify). If the generator
 * drifts or Codex's config format changes, these committed snapshots fail loudly.
 * Deterministic config only — the generated TOML carries no machine paths, timestamps,
 * or tokens — so snapshots are stable across machines. No live delivery (that's CX-E2E).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { installCodex } from "./install";
import { codexConfigFile } from "./paths";
import { uninstallCodex } from "./uninstall";

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

function seed(home: string, body: string): string {
  const path = codexConfigFile({ home });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return body;
}
async function installAndRead(sb: Sandbox): Promise<string> {
  await installCodex({}, sb.home);
  return readFileSync(codexConfigFile({ home: sb.home }), "utf8");
}
function expectNoSecrets(content: string): void {
  expect(content.toLowerCase()).not.toContain("bearer ");
  expect(content).not.toMatch(/bbm_|token["']?\s*[:=]\s*["']\S/i);
}

describe("generated Codex config snapshots (§21.1)", () => {
  it("from-scratch install writes the canonical notify + hooks block", async () => {
    sandbox = createSandbox();
    const out = await installAndRead(sandbox);
    expect(out).toMatchSnapshot();
    expectNoSecrets(out);
  });

  it("patches into a config with a same-event user PostToolUse hook + other keys", async () => {
    sandbox = createSandbox();
    seed(
      sandbox.home,
      [
        'model = "o3"',
        'approval_policy = "on-request"',
        "",
        "[sandbox]",
        'mode = "workspace-write"',
        "",
        "[[hooks.PostToolUse]]",
        'matcher = "Bash"',
        "",
        "[[hooks.PostToolUse.hooks]]",
        'type = "command"',
        'command = "my-own-codex-hook"',
        "",
      ].join("\n"),
    );
    const out = await installAndRead(sandbox);
    expect(out).toMatchSnapshot();
    expectNoSecrets(out);
  });

  it("overwrites a user's single-valued notify (reversible) and preserves other keys", async () => {
    sandbox = createSandbox();
    seed(
      sandbox.home,
      [
        'notify = ["user-notifier", "--flag"]',
        'model = "gpt-5"',
        "",
        "[tui]",
        'theme = "dark"',
        "",
      ].join("\n"),
    );
    const out = await installAndRead(sandbox);
    expect(out).toMatchSnapshot();
    expectNoSecrets(out);
  });

  it("double-install is idempotent (second output identical to first)", async () => {
    sandbox = createSandbox();
    const first = await installAndRead(sandbox);
    await installCodex({}, sandbox.home);
    expect(readFileSync(codexConfigFile({ home: sandbox.home }), "utf8")).toBe(first);
  });

  it("install → uninstall returns to the original fixture byte-for-byte", async () => {
    sandbox = createSandbox();
    const original = seed(
      sandbox.home,
      [
        'model = "o3"',
        "",
        "[[hooks.PostToolUse]]",
        'matcher = ""',
        "",
        "[[hooks.PostToolUse.hooks]]",
        'type = "command"',
        'command = "my-own-codex-hook"',
        "",
      ].join("\n"),
    );
    await installCodex({}, sandbox.home);
    await uninstallCodex({}, sandbox.home);
    expect(readFileSync(codexConfigFile({ home: sandbox.home }), "utf8")).toBe(original);
  });
});
