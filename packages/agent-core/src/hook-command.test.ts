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
  type HookLauncher,
  isBirdyBeepCliEntry,
  isBirdyBeepHookCommand,
  powershellLauncher,
  powershellQuote,
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
    expect(tokenizeCommand(quoted, "darwin")).toEqual(['/home/a$b/"c"/birdybeep']);
  });
});

/**
 * gcgp.9 FOLLOW-UP — cross-platform regression. The first cut of the tokenizer ate `\` inside
 * quotes as a POSIX escape, which shreds every Windows path: `"C:\Users\x\npm\birdybeep.cmd"`
 * became `C:UsersxnpmbirdybeepG.cmd`. Consequences on Windows were worse than the bug being
 * fixed — `doctor` called every healthy install stale, and the matcher stopped recognizing our
 * own entry so `install` would append a duplicate hook instead of rewriting in place.
 *
 * These cases build BOTH platform shapes as literal strings and pass `platform` explicitly, so
 * they exercise Windows semantics on macOS/Linux too. The local pre-push gate is macOS-only —
 * without this, the next such defect would again only surface in CI.
 */
describe("cross-platform command shapes (run on EVERY host)", () => {
  // Exactly what a Windows install writes: `process.execPath` + the npm `.cmd` shim.
  const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
  const WIN_BIN = "C:\\Users\\x\\AppData\\Roaming\\npm\\birdybeep.cmd";
  const WIN_COMMAND = `"${WIN_NODE}" "${WIN_BIN}" hook cursor`;
  // …and what the CI runner that caught this actually had.
  const CI_NODE = "C:\\hostedtoolcache\\windows\\node\\22.22.3\\x64\\node.exe";

  const POSIX_NODE = "/usr/local/bin/node";
  const POSIX_BIN = "/usr/local/bin/birdybeep";
  const POSIX_COMMAND = `"${POSIX_NODE}" "${POSIX_BIN}" hook cursor`;

  it("tokenizes the Windows shape without eating path separators", () => {
    expect(tokenizeCommand(WIN_COMMAND, "win32")).toEqual([WIN_NODE, WIN_BIN, "hook", "cursor"]);
    expect(tokenizeCommand(`"${CI_NODE}" hook cursor`, "win32")).toEqual([
      CI_NODE,
      "hook",
      "cursor",
    ]);
  });

  it("tokenizes the POSIX shape and still un-escapes what a POSIX shell would", () => {
    expect(tokenizeCommand(POSIX_COMMAND, "linux")).toEqual([
      POSIX_NODE,
      POSIX_BIN,
      "hook",
      "cursor",
    ]);
    expect(tokenizeCommand('"/home/a\\$b/birdybeep" hook cursor', "linux")).toEqual([
      "/home/a$b/birdybeep",
      "hook",
      "cursor",
    ]);
  });

  it("keeps Windows-only path shapes intact — UNC and a `$` directory", () => {
    // These are precisely the cases the POSIX branch could NOT get right, which is why
    // tokenizeCommand takes a platform rather than relying on one lenient rule.
    expect(tokenizeCommand('"\\\\server\\share\\birdybeep.cmd" hook cursor', "win32")).toEqual([
      "\\\\server\\share\\birdybeep.cmd",
      "hook",
      "cursor",
    ]);
    expect(tokenizeCommand('"C:\\$Recycle.Bin\\birdybeep.cmd" hook cursor', "win32")).toEqual([
      "C:\\$Recycle.Bin\\birdybeep.cmd",
      "hook",
      "cursor",
    ]);
  });

  it("decodes the doubled quote cmd/PowerShell use for a literal quote", () => {
    expect(tokenizeCommand('"C:\\a""b\\birdybeep.cmd" hook cursor', "win32")).toEqual([
      'C:\\a"b\\birdybeep.cmd',
      "hook",
      "cursor",
    ]);
  });

  it("round-trips shellQuote on BOTH platforms", () => {
    for (const [platform, value] of [
      ["win32", WIN_BIN],
      ["win32", "C:\\$Recycle.Bin\\birdybeep.cmd"],
      ["darwin", POSIX_BIN],
      ["darwin", '/home/a$b/`c`/"d"/birdybeep'],
    ] as [NodeJS.Platform, string][]) {
      expect(
        tokenizeCommand(shellQuote(value, platform), platform),
        `${platform}: ${value}`,
      ).toEqual([value]);
    }
  });

  it("RECOGNIZES our own Windows entry — otherwise install appends a duplicate hook", () => {
    expect(isBirdyBeepHookCommand(WIN_COMMAND, "cursor", [], "win32")).toBe(true);
    expect(isBirdyBeepHookCommand(POSIX_COMMAND, "cursor", [], "linux")).toBe(true);
    // The `.cmd` shim and the package entry the shim re-invokes both count as the CLI.
    expect(
      isBirdyBeepHookCommand(
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\p\\node_modules\\@birdybeep\\cli\\dist\\bin.js" hook claude',
        "claude",
        [],
        "win32",
      ),
    ).toBe(true);
    // …and a foreign Windows hook is still never claimed.
    expect(
      isBirdyBeepHookCommand('"C:\\tools\\superconductor.exe" hook cursor', "cursor", [], "win32"),
    ).toBe(false);
  });

  it("reports Windows absolute paths for stale detection, and calls a live one healthy", () => {
    expect(hookCommandPaths(WIN_COMMAND, "win32")).toEqual([WIN_NODE, WIN_BIN]);
    expect(hookCommandPaths(POSIX_COMMAND, "linux")).toEqual([POSIX_NODE, POSIX_BIN]);
    // The CI failure in one line: a healthy Windows command must report NOTHING stale.
    expect(staleHookCommandPaths(WIN_COMMAND, () => true, "win32")).toEqual([]);
    expect(staleHookCommandPaths(WIN_COMMAND, (p) => p !== WIN_BIN, "win32")).toEqual([WIN_BIN]);
  });

  it("a Windows path survives the POSIX branch too (defence in depth)", () => {
    // Not a supported configuration — a Windows config is only ever read on Windows — but the
    // POSIX rule is deliberately narrow enough that drive paths are not mangled if it happens.
    expect(tokenizeCommand(`"${CI_NODE}" hook cursor`, "linux")).toEqual([
      CI_NODE,
      "hook",
      "cursor",
    ]);
    expect(isBirdyBeepHookCommand(WIN_COMMAND, "cursor", [], "linux")).toBe(true);
  });
});

/**
 * gcgp.16 — the PowerShell form. Copilot's hook entry carries a SEPARATE `powershell` command,
 * and neither the POSIX nor the cmd.exe rule fits it: a line starting with a quoted string is
 * parsed as an EXPRESSION (it would print the path), and a double-quoted string interpolates
 * `$…`. So it gets the call operator plus single quotes, and the tokenizer has to read those
 * back — `install` repair, `uninstall`, and the stale-path check all depend on recognizing our
 * own command after we wrote it.
 */
describe("powershell launcher (gcgp.16)", () => {
  const RUNTIME: HookLauncher = {
    launcher: `"${NODE}" "${BIN}"`,
    source: "runtime",
    argv: [NODE, BIN],
  };

  it("resolveHookLauncher exposes the unquoted argv the quoter needs", () => {
    const launcher = resolveHookLauncher({
      env: {},
      execPath: NODE,
      argv: [NODE, BIN, "agent", "install", "copilot"],
      platform: "darwin",
    });
    expect(launcher.argv).toEqual([NODE, BIN]);
    expect(BARE_HOOK_LAUNCHER.argv).toEqual(["birdybeep"]);
    // An override is a raw shell string the user wrote — there is no argv to re-quote.
    expect(
      resolveHookLauncher({ env: { [HOOK_COMMAND_ENV_VAR]: "mise exec -- birdybeep" } }).argv,
    ).toBeUndefined();
  });

  it("prefixes the call operator and single-quotes each path", () => {
    expect(powershellLauncher(RUNTIME)).toBe(`& '${NODE}' '${BIN}'`);
    expect(powershellLauncher(BARE_HOOK_LAUNCHER)).toBe("birdybeep"); // no `&` needed
    expect(powershellLauncher({ launcher: "mise exec -- birdybeep", source: "override" })).toBe(
      "mise exec -- birdybeep",
    );
  });

  it("keeps `$` literal — the double-quoted form would have expanded it", () => {
    // The exact hazard: PowerShell would read "$Recycle" as a (nonexistent) variable.
    expect(powershellQuote("C:\\$Recycle.Bin\\node.exe")).toBe("'C:\\$Recycle.Bin\\node.exe'");
    expect(powershellQuote("/home/a$b/birdybeep")).toBe("'/home/a$b/birdybeep'");
  });

  it("writes a literal quote by doubling it", () => {
    expect(powershellQuote("/home/o'brien/node")).toBe("'/home/o''brien/node'");
  });

  it("round-trips through the tokenizer on both platforms", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const command = `${powershellLauncher(RUNTIME)} hook copilot sessionStart`;
      expect(tokenizeCommand(command, platform)).toEqual([
        "&",
        NODE,
        BIN,
        "hook",
        "copilot",
        "sessionStart",
      ]);
      // The leading `&` must not stop us recognizing our own command, or finding its paths.
      expect(isBirdyBeepHookCommand(command, "copilot", ["sessionStart"], platform)).toBe(true);
      expect(hookCommandPaths(command, platform)).toEqual([NODE, BIN]);
      expect(staleHookCommandPaths(command, (p) => p !== BIN, platform)).toEqual([BIN]);
    }
  });

  it("a single quote INSIDE double quotes is still an ordinary character", () => {
    // POSIX shellQuote double-quotes, and a path may legitimately contain `'` — that must not be
    // mistaken for the start of a literal region.
    const odd = "/home/o'brien/birdybeep";
    expect(tokenizeCommand(`${shellQuote(odd, "darwin")} hook copilot stop`, "darwin")).toEqual([
      odd,
      "hook",
      "copilot",
      "stop",
    ]);
  });

  it("still refuses to claim a third party's powershell hook", () => {
    expect(
      isBirdyBeepHookCommand("& '/opt/other-tool' hook copilot stop", "copilot", ["stop"]),
    ).toBe(false);
  });
});
