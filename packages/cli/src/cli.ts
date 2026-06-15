/**
 * @birdybeep/cli — the public, side-effect-free CLI API. `runCli` wires the §9.4 command
 * registry into the framework dispatcher with injectable output (so it is fully unit
 * testable); the executable shell lives in `bin.ts`.
 */
import { buildCommands } from "./commands";
import { type Command, dispatch, type Writer } from "./framework";
import { CLI_VERSION } from "./version";

export { buildCommands } from "./commands";
export * from "./framework";
export { CLI_VERSION } from "./version";

export interface RunCliDeps {
  stdout?: Writer;
  stderr?: Writer;
  /** Override the command registry (tests). Defaults to the real §9.4 tree. */
  commands?: Command[];
  /** Skip the config-dir bootstrap (tests without filesystem side effects). */
  ensureConfig?: boolean;
}

/** Run the CLI against an argv slice (without `node`/script path). Returns the exit code. */
export function runCli(argv: string[], deps: RunCliDeps = {}): Promise<number> {
  return dispatch(argv, {
    version: CLI_VERSION,
    commands: deps.commands ?? buildCommands(),
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
    ...(deps.ensureConfig !== undefined ? { ensureConfig: deps.ensureConfig } : {}),
  });
}
