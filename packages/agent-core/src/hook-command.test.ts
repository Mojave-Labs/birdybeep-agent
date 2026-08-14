/**
 * gcgp.9 — the hook-command launcher. The bug being guarded: a bare `birdybeep hook <harness>`
 * dies with exit 127 in a GUI harness's PATH, and so does a bare absolute path to the CLI
 * (its shebang is `#!/usr/bin/env node`, so `node` must also be found). The launcher must
 * therefore name both absolutes, must never guess, and must stay recognizable across shapes
 * so install/uninstall/doctor can repair an entry an older version wrote.
 */
import { describe, expect, it } from "vitest";

import {
  BARE_HOOK_LAUNCHER,
  HOOK_COMMAND_ENV_VAR,
  hookCommand,
  hookCommandPaths,
  isBirdyBeepCliEntry,
  isBirdyBeepHookCommand,
  resolveHookCommand,
  resolveHookLauncher,
  shellQuote,
  staleHookCommandPaths,
  tokenizeCommand,
} from "./hook-command";

const NODE = "/Users/dev/.nvm/versions/node/v22.0.0/bin/node";
const BIN = "/Users/dev/.local/share/pnpm/birdybeep";

describe("resolveHookLauncher", () => {
  it("names BOTH absolutes when the installer is the real CLI (the exit-127 fix)", () => {
    const launcher = resolveHookLauncher({
      env: {},
      execPath: NODE,
      argv: [NODE, BIN, "agent", "install", "cursor"],
      platform: "darwin",
    });
    expect(launcher.source).toBe("runtime");
    expect(launcher.launcher).toBe(`"${NODE}" "${BIN}"`);
    // Absolute CLI path alone is NOT enough — the bin's `env node` shebang needs node too.
    expect(tokenizeCommand(launcher.launcher)).toEqual([NODE, BIN]);
  });

  it("honors an explicit override (wrappers, version managers)", () => {
    const launcher = resolveHookLauncher({
      env: { [HOOK_COMMAND_ENV_VAR]: "  mise exec -- birdybeep  " },
      execPath: NODE,
      argv: [NODE, BIN],
    });
    expect(launcher).toEqual({ launcher: "mise exec -- birdybeep", source: "override" });
  });

  it("falls back to the portable bare command rather than GUESSING another install", () => {
    // argv[1] is a test runner, not our bin — resolution must not claim it.
    const launcher = resolveHookLauncher({
      env: {},
      execPath: NODE,
      argv: [NODE, "/repo/birdybeep-agent/node_modules/vitest/vitest.mjs", "run"],
    });
    expect(launcher).toEqual(BARE_HOOK_LAUNCHER);
    expect(launcher.launcher).toBe("birdybeep");
  });

  it("falls back when argv[1] is missing entirely", () => {
    expect(resolveHookLauncher({ env: {}, execPath: NODE, argv: [NODE] })).toEqual(
      BARE_HOOK_LAUNCHER,
    );
  });

  it("quotes for the harness's shell on each platform", () => {
    const win = resolveHookLauncher({
      env: {},
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      argv: ["node", "C:\\Users\\dev\\AppData\\npm\\birdybeep.cmd"],
      platform: "win32",
    });
    expect(win.launcher).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\dev\\AppData\\npm\\birdybeep.cmd"',
    );
    // POSIX: a `$` inside a path must not be expanded by the shell running the hook.
    expect(shellQuote("/home/a$b/birdybeep", "darwin")).toBe('"/home/a\\$b/birdybeep"');
  });
});

describe("isBirdyBeepCliEntry", () => {
  it("accepts the bin under any global prefix, and the Windows package entry", () => {
    expect(isBirdyBeepCliEntry("/opt/homebrew/bin/birdybeep")).toBe(true);
    expect(isBirdyBeepCliEntry("C:\\Users\\dev\\npm\\birdybeep.cmd")).toBe(true);
    expect(isBirdyBeepCliEntry("C:\\p\\node_modules\\@birdybeep\\cli\\dist\\bin.js")).toBe(true);
  });

  it("rejects a path that merely CONTAINS birdybeep (e.g. the checkout directory)", () => {
    expect(isBirdyBeepCliEntry("/Users/dev/birdybeep-agent/node_modules/vitest/vitest.mjs")).toBe(
      false,
    );
    expect(isBirdyBeepCliEntry("/Users/dev/birdybeep/packages/cli/dist/bin.js")).toBe(false);
    expect(isBirdyBeepCliEntry(undefined)).toBe(false);
    expect(isBirdyBeepCliEntry("")).toBe(false);
  });
});

describe("isBirdyBeepHookCommand", () => {
  const absolute = `"${NODE}" "${BIN}" hook cursor`;

  it("recognizes every shape WE write, so an old entry can be repaired not duplicated", () => {
    expect(isBirdyBeepHookCommand("birdybeep hook cursor", "cursor")).toBe(true);
    expect(isBirdyBeepHookCommand(absolute, "cursor")).toBe(true);
    expect(isBirdyBeepHookCommand(`"${BIN}" hook cursor`, "cursor")).toBe(true);
    expect(
      isBirdyBeepHookCommand("birdybeep hook copilot sessionStart", "copilot", ["sessionStart"]),
    ).toBe(true);
  });

  it("never claims another tool's hook", () => {
    expect(isBirdyBeepHookCommand("superconductor-hook stop", "cursor")).toBe(false);
    expect(isBirdyBeepHookCommand("bun run /x/continual-learning-stop.ts", "cursor")).toBe(false);
    expect(isBirdyBeepHookCommand("my-birdybeep-lookalike", "cursor")).toBe(false);
    expect(isBirdyBeepHookCommand(absolute, "claude")).toBe(false); // wrong harness
    expect(isBirdyBeepHookCommand("hook cursor", "cursor")).toBe(false); // no CLI token
    expect(isBirdyBeepHookCommand(undefined, "cursor")).toBe(false);
    expect(isBirdyBeepHookCommand(42, "cursor")).toBe(false);
  });

  it("does not match a longer/shorter argument tail", () => {
    expect(isBirdyBeepHookCommand("birdybeep hook cursor extra", "cursor")).toBe(false);
    expect(isBirdyBeepHookCommand("birdybeep hook copilot", "copilot", ["sessionStart"])).toBe(
      false,
    );
  });
});

describe("stale-path detection (the absolute-path caveat)", () => {
  it("reports exactly the paths that no longer exist", () => {
    const command = hookCommand("cursor", [], `"${NODE}" "${BIN}"`);
    expect(hookCommandPaths(command)).toEqual([NODE, BIN]);
    expect(staleHookCommandPaths(command, (p) => p !== BIN)).toEqual([BIN]);
    expect(staleHookCommandPaths(command, () => true)).toEqual([]);
  });

  it("has nothing to report for the portable bare command", () => {
    expect(hookCommandPaths("birdybeep hook cursor")).toEqual([]);
    expect(staleHookCommandPaths("birdybeep hook cursor", () => false)).toEqual([]);
  });
});

describe("hookCommand / resolveHookCommand", () => {
  it("defaults to the portable form and appends harness args", () => {
    expect(hookCommand("cursor")).toBe("birdybeep hook cursor");
    expect(hookCommand("copilot", ["sessionStart"])).toBe("birdybeep hook copilot sessionStart");
  });

  it("builds the resolved command end to end", () => {
    expect(resolveHookCommand("cursor", [], { env: {}, execPath: NODE, argv: [NODE, BIN] })).toBe(
      `"${NODE}" "${BIN}" hook cursor`,
    );
  });
});

describe("tokenizeCommand", () => {
  it("keeps quoted paths with spaces in one piece", () => {
    expect(tokenizeCommand('"/Applications/My Tools/node" "/a b/birdybeep" hook cursor')).toEqual([
      "/Applications/My Tools/node",
      "/a b/birdybeep",
      "hook",
      "cursor",
    ]);
  });

  it("round-trips what shellQuote writes, including escapes", () => {
    const quoted = shellQuote('/home/a$b/"c"/birdybeep', "darwin");
    expect(tokenizeCommand(quoted)).toEqual(['/home/a$b/"c"/birdybeep']);
  });
});
