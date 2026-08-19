/**
 * birdybeep-agent-gcgp.16 REGRESSION (Copilot) — the exit-127 bug, reproduced by actually
 * EXECUTING the commands install writes, in an exec context with no usable PATH.
 *
 * Copilot's hook entry is the only one carrying TWO command strings, and they are NOT the same
 * text, so this is not a copy of the Cursor/Claude fix:
 *
 *   bash        `"/abs/node" "/abs/birdybeep" hook copilot <event>`
 *   powershell  `& '/abs/node' '/abs/birdybeep' hook copilot <event>`
 *
 * PowerShell needs the call operator `&` — a line beginning with a quoted string is parsed in
 * EXPRESSION mode and would print the path instead of running it — and single quotes, because a
 * PowerShell double-quoted string interpolates `$…`, which would corrupt a real path such as
 * `C:\$Recycle.Bin\node.exe`. Both hazards are pinned below.
 *
 * COVERAGE NOTE: the bash half executes for real here. The PowerShell half executes wherever a
 * PowerShell is installed — which includes CI's `windows-latest` leg — and falls back to
 * structural assertions (shape + tokenizer round-trip) on a machine without one.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  hookCommandPaths,
  type HookLauncher,
  isBirdyBeepHookCommand,
  powershellLauncher,
  powershellQuote,
  resolveHookLauncher,
  resolveOnPath,
  tokenizeCommand,
} from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import {
  copilotHookCommands,
  generatedCopilotHooks,
  installCopilot,
  installedBirdyBeepCommands,
  isCurrentCopilotHooks,
} from "./install";
import { copilotHooksPath } from "./paths";

const POSIX = process.platform !== "win32";

/**
 * A PowerShell we can actually run the generated command through, if this machine has one —
 * resolved to an ABSOLUTE path. The exec test below runs with PATH emptied (that is the whole
 * point: the launcher must not need PATH), so spawning the shell itself by bare name would fail
 * to launch and report `status: null` rather than testing anything.
 */
function findPowerShell(): string | null {
  for (const candidate of ["pwsh", "powershell"]) {
    const probe = spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" });
    if (probe.status !== 0) continue;
    const absolute = resolveOnPath(candidate);
    if (absolute !== null) return absolute;
  }
  return null;
}
const POWERSHELL = findPowerShell();

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

/** A real Copilot hook payload — camelCase, no event discriminator (hence the event in argv). */
const PAYLOAD = JSON.stringify({
  sessionId: "01998c1e-0000-7000-8000-000000000001",
  cwd: "/Users/dev/code/project",
  toolName: "shell",
});

interface Rig {
  bin: string;
  emptyPath: string;
  receipt: string;
}

function buildRig(sb: Sandbox): Rig {
  const binDir = sb.path("tools");
  const emptyPath = sb.path("empty-path");
  for (const dir of [binDir, emptyPath]) mkdirSync(dir, { recursive: true });
  const receipt = sb.path("receipt.json");
  const bin = `${binDir}/birdybeep`;
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node", // byte-identical to the published @birdybeep/cli bin
      "const fs = require('node:fs');",
      "let stdin = '';",
      "process.stdin.on('data', (c) => { stdin += c; });",
      "process.stdin.on('end', () => {",
      `  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({`,
      "    args: process.argv.slice(2), stdin,",
      "  }));",
      "});",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return { bin, emptyPath, receipt };
}

/** The launcher a real install on this machine would resolve, pointed at the rig's stub bin. */
function rigLauncher(rig: Rig): HookLauncher {
  return resolveHookLauncher({
    env: {},
    execPath: process.execPath,
    argv: [process.execPath, rig.bin],
  });
}

function runBashWithoutPath(command: string, rig: Rig): { status: number | null; stderr: string } {
  const result = spawnSync("/bin/sh", ["-c", command], {
    input: PAYLOAD,
    encoding: "utf8",
    env: { PATH: rig.emptyPath },
  });
  return { status: result.status, stderr: result.stderr ?? "" };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

describe.skipIf(!POSIX)("gcgp.16: the bash command Copilot executes", () => {
  it("REPRO — the bare command dies with exit 127", () => {
    sandbox = createSandbox();
    const rig = buildRig(sandbox);
    const run = runBashWithoutPath("birdybeep hook copilot sessionStart", rig);
    expect(run.status).toBe(127);
    expect(run.stderr).toMatch(/not found/i);
  });

  it("REPRO — an absolute CLI path ALONE is still 127 (its shebang needs `node` on PATH)", () => {
    sandbox = createSandbox();
    const rig = buildRig(sandbox);
    const run = runBashWithoutPath(`"${rig.bin}" hook copilot sessionStart`, rig);
    expect(run.status).toBe(127);
    expect(run.stderr).toMatch(/node/i);
  });

  it("FIXED — the resolved launcher runs, carries the EVENT, and reads the payload on stdin", () => {
    sandbox = createSandbox();
    const rig = buildRig(sandbox);
    const { bash } = copilotHookCommands("agentStop", rigLauncher(rig));

    const run = runBashWithoutPath(bash, rig);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);

    const receipt = asRecord(JSON.parse(readFileSync(rig.receipt, "utf8")));
    // The event name must survive: Copilot payloads carry no discriminator.
    expect(receipt["args"]).toEqual(["hook", "copilot", "agentStop"]);
    expect(receipt["stdin"]).toBe(PAYLOAD);
  });

  it("…and that is EXACTLY what install writes, for every registered event", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    const launcher = rigLauncher(rig);
    await installCopilot({ home: sb.home, env: {}, hookCommand: launcher.launcher });

    const file: unknown = JSON.parse(
      readFileSync(copilotHooksPath({ home: sb.home, env: {} }), "utf8"),
    );
    const hooks = asRecord(asRecord(file)["hooks"]);
    const bash = asRecord((hooks["sessionEnd"] as unknown[])[0])["bash"] as string;
    // Run the string straight out of the file — no reconstruction.
    expect(runBashWithoutPath(bash, rig).status).toBe(0);
    expect(asRecord(JSON.parse(readFileSync(rig.receipt, "utf8")))["args"]).toEqual([
      "hook",
      "copilot",
      "sessionEnd",
    ]);
  });
});

describe("gcgp.16: the powershell command Copilot executes", () => {
  it("uses the call operator and single-quoted paths (not the bash text)", () => {
    const launcher: HookLauncher = {
      launcher: '"/abs/node" "/abs/birdybeep"',
      source: "runtime",
      argv: ["/abs/node", "/abs/birdybeep"],
    };
    const { bash, powershell } = copilotHookCommands("preToolUse", launcher);
    expect(bash).toBe('"/abs/node" "/abs/birdybeep" hook copilot preToolUse');
    // `&` is REQUIRED: without it PowerShell parses the line as an expression and prints the path.
    expect(powershell).toBe("& '/abs/node' '/abs/birdybeep' hook copilot preToolUse");
    expect(powershell).not.toBe(bash);
  });

  it("a `$` in a path is literal — the double-quoted form would have eaten it", () => {
    const win = "C:\\$Recycle.Bin\\node.exe";
    expect(powershellQuote(win)).toBe("'C:\\$Recycle.Bin\\node.exe'");
    // …and it round-trips back out for the stale-path check.
    const command = `& ${powershellQuote(win)} 'C:\\p\\birdybeep' hook copilot sessionStart`;
    expect(tokenizeCommand(command, "win32")).toEqual([
      "&",
      win,
      "C:\\p\\birdybeep",
      "hook",
      "copilot",
      "sessionStart",
    ]);
    expect(hookCommandPaths(command, "win32")).toEqual([win, "C:\\p\\birdybeep"]);
  });

  it("a literal quote in a path is doubled and round-trips", () => {
    const odd = "/home/o'brien/node";
    expect(powershellQuote(odd)).toBe("'/home/o''brien/node'");
    expect(tokenizeCommand(`& ${powershellQuote(odd)} hook copilot stop`)).toEqual([
      "&",
      odd,
      "hook",
      "copilot",
      "stop",
    ]);
  });

  it("the powershell form is still recognized as OURS (install repair + uninstall depend on it)", () => {
    const launcher: HookLauncher = {
      launcher: '"/abs/node" "/abs/birdybeep"',
      source: "runtime",
      argv: ["/abs/node", "/abs/birdybeep"],
    };
    const { powershell } = copilotHookCommands("postToolUse", launcher);
    expect(isBirdyBeepHookCommand(powershell, "copilot", ["postToolUse"])).toBe(true);
    // …and never claims a third party's, nor the wrong event.
    expect(isBirdyBeepHookCommand(powershell, "copilot", ["sessionStart"])).toBe(false);
    expect(
      isBirdyBeepHookCommand("& '/opt/other' hook copilot postToolUse", "copilot", ["postToolUse"]),
    ).toBe(false);
  });

  it("a bare launcher needs no call operator", () => {
    const { bash, powershell } = copilotHookCommands("sessionStart");
    expect(bash).toBe("birdybeep hook copilot sessionStart");
    expect(powershell).toBe("birdybeep hook copilot sessionStart");
    expect(powershellLauncher({ launcher: "birdybeep", source: "bare", argv: ["birdybeep"] })).toBe(
      "birdybeep",
    );
  });

  it("an override is passed through verbatim — never re-quoted", () => {
    const override: HookLauncher = { launcher: "mise exec -- birdybeep", source: "override" };
    expect(powershellLauncher(override)).toBe("mise exec -- birdybeep");
  });

  it.skipIf(POWERSHELL === null)(
    `RUNS — the generated powershell command actually executes (${POWERSHELL ?? "no PowerShell"})`,
    () => {
      sandbox = createSandbox();
      const rig = buildRig(sandbox);
      const { powershell } = copilotHookCommands("errorOccurred", rigLauncher(rig));
      const run = spawnSync(POWERSHELL!, ["-NoProfile", "-Command", powershell], {
        input: PAYLOAD,
        encoding: "utf8",
        env: { PATH: rig.emptyPath },
      });
      expect(run.stderr ?? "").toBe("");
      expect(run.status).toBe(0);
      const receipt = asRecord(JSON.parse(readFileSync(rig.receipt, "utf8")));
      expect(receipt["args"]).toEqual(["hook", "copilot", "errorOccurred"]);
      expect(receipt["stdin"]).toBe(PAYLOAD);
    },
  );
});

describe("gcgp.16: status + doctor can still see a launcher-bearing Copilot file", () => {
  it("recognizes an absolute-launcher file as current (not as foreign drift)", () => {
    const launcher: HookLauncher = {
      launcher: '"/abs/node" "/abs/birdybeep"',
      source: "runtime",
      argv: ["/abs/node", "/abs/birdybeep"],
    };
    expect(isCurrentCopilotHooks(generatedCopilotHooks(launcher))).toBe(true);
    expect(isCurrentCopilotHooks(generatedCopilotHooks())).toBe(true); // the older bare shape too
  });

  it("still rejects a foreign or half-rewritten file", () => {
    const file = generatedCopilotHooks();
    const hooks = asRecord(file["hooks"]);
    // Only the bash half is ours — that is drift, not a BirdyBeep file.
    hooks["sessionStart"] = [
      {
        type: "command",
        bash: "birdybeep hook copilot sessionStart",
        powershell: "some-other-tool",
        timeoutSec: 10,
      },
    ];
    expect(isCurrentCopilotHooks(file)).toBe(false);
    expect(isCurrentCopilotHooks({ version: 1, hooks: {} })).toBe(false);
    expect(isCurrentCopilotHooks({ company: true })).toBe(false);
  });

  it("surfaces the absolute paths doctor checks for staleness, from BOTH shells", () => {
    const launcher: HookLauncher = {
      launcher: '"/abs/node" "/abs/birdybeep"',
      source: "runtime",
      argv: ["/abs/node", "/abs/birdybeep"],
    };
    const commands = installedBirdyBeepCommands(generatedCopilotHooks(launcher));
    // 8 events × 2 shells, all distinct strings.
    expect(commands).toHaveLength(16);
    for (const command of commands) {
      expect(hookCommandPaths(command)).toEqual(["/abs/node", "/abs/birdybeep"]);
    }
  });
});
