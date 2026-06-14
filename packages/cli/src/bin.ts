#!/usr/bin/env node
import { runCli } from "./cli.js";

// Executable entry: the only side-effectful module. Use exitCode (not process.exit) so
// buffered stdout/stderr flushes before the process exits.
runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`birdybeep: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
