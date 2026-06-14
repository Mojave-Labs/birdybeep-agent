#!/usr/bin/env node
import { runCli } from "./cli.js";
import { nodeVersionError } from "./node-check.js";

// Executable entry: the only side-effectful module. Guard the Node version first (clear
// message instead of a cryptic missing-API crash), then dispatch. Use exitCode (not
// process.exit) so buffered stdout/stderr flushes before the process exits.
const versionError = nodeVersionError(process.versions.node);
if (versionError !== null) {
  process.stderr.write(`${versionError}\n`);
  process.exitCode = 1;
} else {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`birdybeep: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
