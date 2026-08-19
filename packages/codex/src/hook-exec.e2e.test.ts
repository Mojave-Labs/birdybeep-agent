/**
 * birdybeep-agent-gcgp.16 REGRESSION (Codex) — the exit-127 bug, reproduced by actually EXECUTING
 * the command install writes, in an exec context with no usable PATH.
 *
 * Codex is usually terminal-launched and inherits the user's shell PATH, which is why this ranked
 * below Cursor. It is not immune: the ChatGPT desktop app spawns Codex too, and that process has
 * no shell environment — the same `command not found` (exit 127) that Cursor logged for the Claude
 * adapter. Both halves of the gcgp.9 lesson are pinned here: a bare command fails, AND the obvious
 * fix (absolute CLI path alone) fails the SAME way, because the published bin's shebang is
 * `#!/usr/bin/env node` and `node` is not findable either.
 *
 * The stub bin is byte-identical in shebang to the published `@birdybeep/cli` bin and records what
 * it received, so "the hook ran" is proven by a receipt written by the launched process — not by
 * an exit code alone.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { resolveHookCommand } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { parse } from "smol-toml";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { installCodex, installedBirdyBeepCommands } from "./install";
import { codexConfigFile } from "./paths";

const POSIX = process.platform !== "win32";

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

/** A real Codex lifecycle hook payload — stdin JSON, snake_case, keyed by hook_event_name. */
const PAYLOAD = JSON.stringify({
  hook_event_name: "Stop",
  session_id: "01998c1e-0000-7000-8000-000000000001",
  cwd: "/Users/dev/code/project",
  turn_id: "turn_1",
  model: "gpt-5",
});

interface Rig {
  /** A stand-in for the published bin: a Node script with the SAME `env node` shebang. */
  bin: string;
  /** An empty directory used as the entire PATH — nothing is findable through it. */
  emptyPath: string;
  /** Where the stub records that it ran, and with what. */
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

/** Run a hook command the way a PATH-less harness does: a shell, with nothing on PATH. */
function runWithoutPath(command: string, rig: Rig): { status: number | null; stderr: string } {
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

describe.skipIf(!POSIX)("gcgp.16: what Codex actually executes", () => {
  it("REPRO — the bare command dies with exit 127", () => {
    sandbox = createSandbox();
    const rig = buildRig(sandbox);
    const run = runWithoutPath("birdybeep hook codex", rig);
    expect(run.status).toBe(127);
    expect(run.stderr).toMatch(/not found/i);
  });

  it("REPRO — an absolute CLI path ALONE is still 127 (its shebang needs `node` on PATH)", () => {
    sandbox = createSandbox();
    const rig = buildRig(sandbox);
    const run = runWithoutPath(`"${rig.bin}" hook codex`, rig);
    expect(run.status).toBe(127);
    expect(run.stderr).toMatch(/node/i); // `env: node: No such file or directory`
  });

  it("FIXED — the resolved launcher runs, gets its args, and reads the payload on stdin", () => {
    sandbox = createSandbox();
    const rig = buildRig(sandbox);
    const command = resolveHookCommand("codex", [], {
      env: {},
      execPath: process.execPath,
      argv: [process.execPath, rig.bin],
    });

    const run = runWithoutPath(command, rig);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);

    const receipt = asRecord(JSON.parse(readFileSync(rig.receipt, "utf8")));
    expect(receipt["args"]).toEqual(["hook", "codex"]);
    expect(receipt["stdin"]).toBe(PAYLOAD); // Codex delivers hook payloads on stdin
  });

  it("…and that is EXACTLY the command install writes into config.toml", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    const command = resolveHookCommand("codex", [], {
      env: {},
      execPath: process.execPath,
      argv: [process.execPath, rig.bin],
    });
    await installCodex({ hookCommand: command, dataDir: sb.path("data") }, sb.home);

    const config = asRecord(parse(readFileSync(codexConfigFile({ home: sb.home }), "utf8")));
    expect(installedBirdyBeepCommands(config)).toEqual([command]);
    // Run the string straight out of the file — no reconstruction.
    expect(runWithoutPath(installedBirdyBeepCommands(config)[0]!, rig).status).toBe(0);
  });

  it("re-running install REPAIRS a drifted command in place, never duplicating the hook", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const rig = buildRig(sb);
    const opts = { dataDir: sb.path("data") };
    // An older install wrote the bare command…
    await installCodex({ ...opts, hookCommand: "birdybeep hook codex" }, sb.home);
    // …and the current one resolves an absolute launcher.
    const repaired = resolveHookCommand("codex", [], {
      env: {},
      execPath: process.execPath,
      argv: [process.execPath, rig.bin],
    });
    await installCodex({ ...opts, hookCommand: repaired }, sb.home);

    const config = asRecord(parse(readFileSync(codexConfigFile({ home: sb.home }), "utf8")));
    expect(installedBirdyBeepCommands(config)).toEqual([repaired]); // the stale one is GONE
    for (const entries of Object.values(asRecord(config["hooks"]))) {
      expect(Array.isArray(entries) && entries.length).toBe(1); // one entry per event, not two
    }
    expect(runWithoutPath(repaired, rig).status).toBe(0);
  });
});
