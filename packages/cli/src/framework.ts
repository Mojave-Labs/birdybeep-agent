/**
 * The CLI framework (§9.4): a small zero-dependency command dispatcher every `birdybeep`
 * command plugs into. Owns global flag parsing (`--json` / `--non-interactive` /
 * `--version` / `--help`), nested subcommand routing, help rendering, the config-dir
 * bootstrap, a json-aware output layer, and a shared exit-code convention. Network/auth,
 * adapter, and secret logic live in the individual commands — never here.
 *
 * Kept dependency-light on purpose: this code installs into developers' machines, so the
 * smaller + more auditable the surface, the better (§16.4).
 */
import { mkdirSync } from "node:fs";

import { birdyBeepConfigDir } from "@birdybeep/agent-core";

/** Shared exit-code convention so callers (humans + agents) can branch on the result. */
export const EXIT = { OK: 0, ERROR: 1, USAGE: 2 } as const;

/** A minimal output sink (process.stdout/stderr in prod; capturing buffers in tests). */
export interface Writer {
  write(s: string): void;
}

export interface GlobalFlags {
  /** Machine-readable JSON output for agents/scripts. */
  json: boolean;
  /** Never prompt; fail fast (non-zero) when a required value is missing. */
  nonInteractive: boolean;
  help: boolean;
  version: boolean;
}

/** Json-aware output. `line`/`result` are mutually exclusive by mode so stdout stays clean. */
export interface Io {
  readonly json: boolean;
  /** Human line → stdout (suppressed in `--json` mode). */
  line(text: string): void;
  /** Always → stderr (errors/warnings show in both modes). */
  errline(text: string): void;
  /** Structured result → stdout as JSON (only in `--json` mode). */
  result(value: unknown): void;
  /** Emit the right one for the mode: human text, or the structured value as JSON. */
  emit(human: string, json: unknown): void;
}

export function createIo(json: boolean, stdout: Writer, stderr: Writer): Io {
  return {
    json,
    line: (text) => {
      if (!json) stdout.write(`${text}\n`);
    },
    errline: (text) => stderr.write(`${text}\n`),
    result: (value) => {
      if (json) stdout.write(`${JSON.stringify(value)}\n`);
    },
    emit: (human, value) => {
      if (json) stdout.write(`${JSON.stringify(value)}\n`);
      else stdout.write(`${human}\n`);
    },
  };
}

export interface CommandContext {
  /** Positional args after the resolved command path. */
  args: string[];
  flags: GlobalFlags;
  io: Io;
}

export interface Command {
  name: string;
  summary: string;
  /** One-line usage shown in the command's own `--help`. */
  usage?: string;
  /** Nested subcommands (e.g. `agent install` / `agent uninstall`). */
  subcommands?: Command[];
  /** Command logic; returns the intended exit code. Absent for pure command groups. */
  run?(ctx: CommandContext): Promise<number> | number;
}

/** Thrown by a command when a required value is missing under `--non-interactive`. */
export class MissingInputError extends Error {
  constructor(readonly field: string) {
    super(`missing required value: ${field}`);
    this.name = "MissingInputError";
  }
}

/**
 * Resolve a value that may require interaction. Returns `provided` when present; otherwise
 * throws {@link MissingInputError} under `--non-interactive` (so the CLI fails fast instead
 * of hanging), or returns undefined for the caller to prompt in interactive mode.
 */
export function requireValue<T>(ctx: CommandContext, field: string, provided: T | undefined): T {
  if (provided !== undefined) return provided;
  if (ctx.flags.nonInteractive) throw new MissingInputError(field);
  throw new MissingInputError(field); // interactive prompting is a per-command concern; default fail-fast
}

const GLOBAL_FLAG_TOKENS = new Set([
  "--json",
  "--non-interactive",
  "--version",
  "-v",
  "--help",
  "-h",
]);

/** Split a raw argv into global flags + the remaining (command path + positional) tokens. */
export function parseGlobalFlags(argv: string[]): { flags: GlobalFlags; rest: string[] } {
  const flags: GlobalFlags = { json: false, nonInteractive: false, help: false, version: false };
  const rest: string[] = [];
  for (const token of argv) {
    switch (token) {
      case "--json":
        flags.json = true;
        break;
      case "--non-interactive":
        flags.nonInteractive = true;
        break;
      case "--version":
      case "-v":
        flags.version = true;
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      default:
        rest.push(token);
    }
  }
  return { flags, rest };
}

/** Is `token` an unknown long/short flag (after global flags were stripped)? */
function isUnknownFlag(token: string): boolean {
  return token.startsWith("-") && !GLOBAL_FLAG_TOKENS.has(token);
}

function renderRootHelp(version: string, commands: Command[]): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const lines = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return [
    `birdybeep ${version} — stream coding-agent lifecycle events to BirdyBeep.`,
    "",
    "Usage:",
    "  birdybeep <command> [options]",
    "",
    "Commands:",
    ...lines,
    "",
    "Global options:",
    "  --json              Machine-readable JSON output",
    "  --non-interactive   Never prompt; fail fast if input is required",
    "  -h, --help          Show help (root or per-command)",
    "  -v, --version       Show the CLI version",
  ].join("\n");
}

function renderCommandHelp(path: string, command: Command): string {
  const lines = [
    `birdybeep ${path} — ${command.summary}`,
    "",
    "Usage:",
    `  ${command.usage ?? `birdybeep ${path} [options]`}`,
  ];
  if (command.subcommands && command.subcommands.length > 0) {
    const width = Math.max(...command.subcommands.map((c) => c.name.length));
    lines.push(
      "",
      "Subcommands:",
      ...command.subcommands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    );
  }
  return lines.join("\n");
}

export interface DispatchDeps {
  version: string;
  commands: Command[];
  stdout: Writer;
  stderr: Writer;
  /** Skip the config-dir bootstrap (tests that don't want filesystem side effects). */
  ensureConfig?: boolean;
}

/**
 * Run the CLI against an argv slice (without `node`/script path). Resolves the command
 * (with nested subcommands), handles `--help`/`--version`, and returns the exit code.
 * Never throws — command errors become a stderr message + {@link EXIT.ERROR}.
 */
export async function dispatch(argv: string[], deps: DispatchDeps): Promise<number> {
  const { flags, rest } = parseGlobalFlags(argv);
  const io = createIo(flags.json, deps.stdout, deps.stderr);

  // Config dir is created on first run (non-secret CLI config only — never a token).
  if (deps.ensureConfig !== false) {
    try {
      mkdirSync(birdyBeepConfigDir(), { recursive: true, mode: 0o700 });
    } catch {
      /* non-fatal: a read-only config dir is surfaced by `doctor`, not here */
    }
  }

  if (flags.version) {
    io.emit(deps.version, { version: deps.version });
    return EXIT.OK;
  }

  // Resolve the command path (supports one level of nested subcommands).
  let command: Command | undefined = deps.commands.find((c) => c.name === rest[0]);
  const pathParts: string[] = [];
  let argsStart = 1;
  if (command) {
    pathParts.push(command.name);
    if (command.subcommands && command.subcommands.length > 0) {
      const sub = command.subcommands.find((c) => c.name === rest[1]);
      if (sub) {
        command = sub;
        pathParts.push(sub.name);
        argsStart = 2;
      }
    }
  }

  if (rest.length === 0 || (flags.help && command === undefined)) {
    io.emit(renderRootHelp(deps.version, deps.commands), {
      version: deps.version,
      commands: deps.commands.map((c) => ({ name: c.name, summary: c.summary })),
    });
    return EXIT.OK;
  }

  if (command === undefined) {
    io.errline(`birdybeep: unknown command "${rest[0]}". Run \`birdybeep --help\`.`);
    return EXIT.USAGE;
  }

  const path = pathParts.join(" ");
  if (flags.help) {
    io.emit(renderCommandHelp(path, command), {
      name: path,
      summary: command.summary,
      usage: command.usage,
      subcommands: command.subcommands?.map((c) => ({ name: c.name, summary: c.summary })),
    });
    return EXIT.OK;
  }

  if (command.run === undefined) {
    // A pure command group invoked without a subcommand → show its help as a usage error.
    io.errline(renderCommandHelp(path, command));
    return EXIT.USAGE;
  }

  const args = rest.slice(argsStart);
  const unknown = args.find(isUnknownFlag);
  if (unknown !== undefined) {
    io.errline(`birdybeep ${path}: unknown option "${unknown}".`);
    return EXIT.USAGE;
  }

  try {
    return await command.run({ args, flags, io });
  } catch (err) {
    if (err instanceof MissingInputError) {
      io.errline(
        `birdybeep ${path}: ${err.message} (re-run without --non-interactive to be prompted).`,
      );
      return EXIT.USAGE;
    }
    io.errline(`birdybeep ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.ERROR;
  }
}
