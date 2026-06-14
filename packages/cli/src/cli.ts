/**
 * @birdybeep/cli — the public, side-effect-free CLI API. `runCli` wires the §9.4 command
 * registry into the framework dispatcher with injectable output (so it is fully unit
 * testable); the executable shell lives in `bin.ts`.
 */
import { buildCommands } from "./commands";
import { type Command, dispatch, type Writer } from "./framework";

export { buildCommands } from "./commands";
export * from "./framework";

/** CLI version marker — replaced by the real build/version pipeline (a-release). */
export const CLI_VERSION = "0.0.0";

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
