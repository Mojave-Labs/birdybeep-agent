/**
 * CX-INSTALL proof (hermetic temp HOME): empty HOME → minimal valid config.toml with
 * the BirdyBeep notify + hook block; realistic pre-existing config.toml → only BB
 * entries added, all prior keys preserved, a user hook kept alongside ours, backup
 * written; double-install idempotent; status needs_trust + trust message; no token.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { parse } from "smol-toml";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BIRDYBEEP_HOOK_COMMAND,
  BIRDYBEEP_HOOK_EVENTS,
  BIRDYBEEP_NOTIFY,
  installCodex,
  isBirdyBeepHookEntry,
} from "./install";
import { codexConfigFile } from "./paths";

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

function readConfig(path: string): Record<string, unknown> {
  return parse(readFileSync(path, "utf8"));
}
function hookEntries(config: Record<string, unknown>, event: string): unknown[] {
  const hooks = config["hooks"];
  const list =
    typeof hooks === "object" && hooks !== null
      ? (hooks as Record<string, unknown>)[event]
      : undefined;
  return Array.isArray(list) ? list : [];
}

describe("install into an empty HOME", () => {
  it("creates config.toml with the BirdyBeep notify + hook block and returns needs_trust", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    const r = await installCodex({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.status).toBe("needs_trust");
    expect(r.requiredActions.join(" ")).toMatch(/\/hooks/); // one-time trust instruction
    expect(r.backupFiles).toEqual([]);

    const config = readConfig(path);
    expect(config["notify"]).toEqual([...BIRDYBEEP_NOTIFY]);
    for (const event of BIRDYBEEP_HOOK_EVENTS) {
      expect(hookEntries(config, event).some(isBirdyBeepHookEntry)).toBe(true);
    }
  });
});

describe("install over a realistic pre-existing config.toml", () => {
  const seed = [
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
  ].join("\n");

  it("adds only BirdyBeep entries, preserves prior keys + a user hook, and backs up", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seed);

    const r = await installCodex({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.backupFiles).toEqual([`${path}.birdybeep-backup`]);
    // Backup is the original bytes.
    expect(readFileSync(`${path}.birdybeep-backup`, "utf8")).toBe(seed);

    const config = readConfig(path);
    // Prior keys preserved.
    expect(config["model"]).toBe("o3");
    expect(config["approval_policy"]).toBe("on-request");
    expect(config["sandbox"]).toEqual({ mode: "workspace-write" });
    // notify is ours.
    expect(config["notify"]).toEqual([...BIRDYBEEP_NOTIFY]);
    // The user's PostToolUse hook is preserved ALONGSIDE BirdyBeep's.
    const postToolUse = hookEntries(config, "PostToolUse");
    expect(postToolUse.some((e) => JSON.stringify(e).includes("my-own-codex-hook"))).toBe(true);
    expect(postToolUse.some(isBirdyBeepHookEntry)).toBe(true);
    for (const event of BIRDYBEEP_HOOK_EVENTS) {
      expect(hookEntries(config, event).some(isBirdyBeepHookEntry)).toBe(true);
    }
  });

  it("is idempotent — a second install produces an identical file", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seed);
    await installCodex({}, sandbox.home);
    const afterFirst = readFileSync(path, "utf8");
    const r2 = await installCodex({}, sandbox.home);
    expect(r2.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
  });
});

describe("security", () => {
  it("never writes a token; only the command reference appears", async () => {
    sandbox = createSandbox();
    const path = codexConfigFile({ home: sandbox.home });
    await installCodex({}, sandbox.home);
    const content = readFileSync(path, "utf8");
    expect(content).toContain(BIRDYBEEP_HOOK_COMMAND);
    expect(content.toLowerCase()).not.toContain("bearer ");
    expect(content).not.toMatch(/bbm_|token["']?\s*[:=]\s*["']\S/i);
  });
});
