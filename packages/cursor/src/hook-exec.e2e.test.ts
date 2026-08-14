/**
 * gcgp.9 REGRESSION — the exit-127 bug, reproduced by actually EXECUTING the command we write,
 * in the environment Cursor executes it in.
 *
 * The real failure, from Cursor's own hook log on 2026-08-07:
 *
 *     Command: birdybeep hook claude (830ms) exit code: 127
 *     STDERR:  zsh:1: command not found: birdybeep
 *
 * Cursor runs hooks from the Electron main process (cwd `~/.cursor`), whose PATH is the launchd
 * environment — not the user's shell PATH — so a globally installed CLI is invisible. This suite
 * reproduces that with a PATH containing nothing, asserts the bare command still fails exactly
 * that way, asserts the OBVIOUS fix (absolute CLI path alone) fails the SAME way for a second
 * reason (`#!/usr/bin/env node` needs `node` on PATH too), and proves the command install
 * actually writes survives it and receives the payload on stdin.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

import { resolveHookCommand } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { installCursor, installedBirdyBeepCommands } from "./install";
import { cursorHooksPath } from "./paths";

const POSIX = process.platform !== "win32";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

const PAYLOAD = JSON.stringify({
  hook_event_name: "beforeMCPExecution",
  session_id: "00000000-0000-4000-8000-000000000001",
  tool_name: "execute_sql",
  mcp_server_name: "supabase",
});

interface Rig {
  /** A stand-in for the published bin: a Node script with the SAME `env node` shebang. */
  bin: string;
  /** Cursor's hook cwd. */
  cwd: string;
  /** An empty directory used as the entire PATH — nothing is findable through it. */
  emptyPath: string;
  /** Where the stub records that it ran, and with what. */
  receipt: string;
}

function buildRig(sb: Sandbox): Rig {
  const binDir = sb.path("tools");
  const emptyPath = sb.path("empty-path");
  const cwd = sb.path(".cursor");
  for (const dir of [binDir, emptyPath, cwd]) mkdirSync(dir, { recursive: true });
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
      "    args: process.argv.slice(2), cwd: process.cwd(), stdin,",
      "  }));",
      "});",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return { bin, cwd, emptyPath, receipt };
}

/** Run a hook command the way Cursor does: through a shell, with a PATH that has nothing on it. */
function runAsCursorWould(command: string, rig: Rig): { status: number | null; stderr: string } {
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd: rig.cwd,
    input: PAYLOAD,
    encoding: "utf8",
    env: { PATH: rig.emptyPath },
  });
  return { status: result.status, stderr: result.stderr ?? "" };
}

describe.skipIf(!POSIX)("gcgp.9: what Cursor actually executes", () => {
  it("REPRO — the bare command dies with exit 127, exactly as Cursor logged it", () => {
    sandbox = createSandbox();
    const rig = buildRig(sandbox);
    const run = runAsCursorWould("birdybeep hook cursor", rig);
    expect(run.status).toBe(127);
    expect(run.stderr).toMatch(/not found/i);
  });

  it("REPRO — an absolute CLI path ALONE is still 127 (its shebang needs `node` on PATH)", () => {
    sandbox = createSandbox();
    const rig = buildRig(sandbox);
    const run = runAsCursorWould(`"${rig.bin}" hook cursor`, rig);
    expect(run.status).toBe(127);
    expect(run.stderr).toMatch(/node/i); // `env: node: No such file or directory`
  });

  it("FIXED — the resolved launcher runs, gets its args, and reads the payload on stdin", () => {
    sandbox = createSandbox();
    const rig = buildRig(sandbox);
    const command = resolveHookCommand("cursor", [], {
      env: {},
      execPath: process.execPath,
      argv: [process.execPath, rig.bin],
    });

    const run = runAsCursorWould(command, rig);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);

    const receipt = JSON.parse(readFileSync(rig.receipt, "utf8")) as Record<string, unknown>;
    expect(receipt["args"]).toEqual(["hook", "cursor"]);
    expect(receipt["stdin"]).toBe(PAYLOAD); // Cursor delivers the payload on stdin
    // …from ~/.cursor, where Cursor runs hooks (realpath: macOS temp dirs are symlinked).
    expect(receipt["cwd"]).toBe(realpathSync(rig.cwd));
  });

  it("…and that is EXACTLY the command install writes into hooks.json", async () => {
    sandbox = createSandbox();
    const rig = buildRig(sandbox);
    const command = resolveHookCommand("cursor", [], {
      env: {},
      execPath: process.execPath,
      argv: [process.execPath, rig.bin],
    });
    await installCursor({ hookCommand: command }, sandbox.home);

    const config = JSON.parse(readFileSync(cursorHooksPath(sandbox.home), "utf8")) as Record<
      string,
      unknown
    >;
    expect(installedBirdyBeepCommands(config)).toEqual([command]);
    // Run the string straight out of the file — no reconstruction.
    expect(runAsCursorWould(installedBirdyBeepCommands(config)[0]!, rig).status).toBe(0);
  });
});
