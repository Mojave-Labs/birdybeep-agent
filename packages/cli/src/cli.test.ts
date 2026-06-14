/**
 * CLI framework proof (hermetic temp HOME): `--help` lists every §9.4 command, each
 * subcommand has its own `--help`, `--version` + `--json` produce parseable output,
 * `--non-interactive` fails fast (non-zero, no hang) on a missing required value, unknown
 * commands/flags exit non-zero, and the config dir is created under the temp HOME with no
 * token material in it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { birdyBeepConfigDir } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { CLI_VERSION, type Command, EXIT, requireValue, runCli } from "./cli";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}

const ALL_COMMANDS = [
  "login",
  "logout",
  "status",
  "test",
  "doctor",
  "agent",
  "hook",
  "queue",
  "report-status",
];

describe("help + version", () => {
  it("lists every §9.4 command in --help", async () => {
    const out = capture();
    const code = await runCli(["--help"], {
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    for (const name of ALL_COMMANDS) expect(out.text()).toContain(name);
  });

  it("no args prints help and exits 0", async () => {
    const out = capture();
    expect(await runCli([], { stdout: out.writer, stderr: out.writer, ensureConfig: false })).toBe(
      EXIT.OK,
    );
    expect(out.text()).toContain("Usage:");
  });

  it("prints the version and exits 0", async () => {
    const out = capture();
    const code = await runCli(["--version"], {
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(out.text().trim()).toBe(CLI_VERSION);
  });

  it("a subcommand has its own --help", async () => {
    const out = capture();
    await runCli(["agent", "install", "--help"], {
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(out.text()).toContain("birdybeep agent install");
  });

  it("a command group invoked without a subcommand shows usage (non-zero)", async () => {
    const out = capture();
    const code = await runCli(["agent"], {
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.USAGE);
    expect(out.text()).toContain("Subcommands:");
  });
});

describe("--json output", () => {
  it("--version --json is valid JSON with the version", async () => {
    const out = capture();
    await runCli(["--version", "--json"], {
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(JSON.parse(out.text())).toEqual({ version: CLI_VERSION });
  });

  it("--help --json is valid JSON listing the commands", async () => {
    const out = capture();
    await runCli(["--help", "--json"], {
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    const parsed = JSON.parse(out.text()) as { commands: { name: string }[] };
    expect(parsed.commands.map((c) => c.name)).toEqual(expect.arrayContaining(ALL_COMMANDS));
  });
});

describe("errors + exit codes", () => {
  it("unknown command exits USAGE (2)", async () => {
    const out = capture();
    const code = await runCli(["frobnicate"], {
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.USAGE);
    expect(out.text()).toContain('unknown command "frobnicate"');
  });

  it("unknown flag on a known command exits USAGE (2)", async () => {
    const out = capture();
    const code = await runCli(["status", "--bogus"], {
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.USAGE);
    expect(out.text()).toContain('unknown option "--bogus"');
  });

  it("a not-yet-implemented command exits non-zero with a ticket reference", async () => {
    const out = capture();
    const code = await runCli(["login"], {
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(out.text()).toMatch(/not implemented yet/);
  });
});

describe("--non-interactive fails fast (never hangs)", () => {
  const needy: Command[] = [
    {
      name: "needy",
      summary: "requires a value",
      run: (ctx) => {
        const code = requireValue(ctx, "code", ctx.args[0]);
        ctx.io.line(`got ${code}`);
        return EXIT.OK;
      },
    },
  ];

  it("returns non-zero (USAGE) when a required value is missing under --non-interactive", async () => {
    const out = capture();
    const code = await runCli(["needy", "--non-interactive"], {
      stdout: out.writer,
      stderr: out.writer,
      commands: needy,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.USAGE);
    expect(out.text()).toContain("missing required value: code");
  });

  it("succeeds when the value is provided", async () => {
    const out = capture();
    const code = await runCli(["needy", "xyz", "--non-interactive"], {
      stdout: out.writer,
      stderr: out.writer,
      commands: needy,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(out.text()).toContain("got xyz");
  });
});

describe("config dir bootstrap (temp HOME)", () => {
  it("creates the config dir on first run and writes no token material", async () => {
    sandbox = createSandbox();
    const out = capture();
    await runCli(["--version"], { stdout: out.writer, stderr: out.writer }); // ensureConfig defaults on
    const dir = birdyBeepConfigDir();
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(sandbox.home)).toBe(true); // under the temp HOME, never a real path
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isFile()) {
        expect(readFileSync(full, "utf8")).not.toMatch(/bbm_|bearer/i);
      }
    }
  });
});
