#!/usr/bin/env node
import { run } from "./cli.js";

// Executable entry: the only side-effectful module. Use exitCode (not
// process.exit) so buffered stdout/stderr flushes before the process exits.
process.exitCode = run(process.argv.slice(2));
