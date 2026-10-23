// Test process preload: redirect the absolute system executable to a per-run fixture.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute } from "node:path";

const spawn = childProcess.spawn;
childProcess.spawn = function (program, ...args) {
  if (program === "/usr/bin/security" || program === "security") {
    const shim = process.env.BIRDYBEEP_TEST_SECURITY_SHIM;
    if (!shim || !isAbsolute(shim)) throw new Error("absolute test Keychain fixture required");
    return spawn.call(this, shim, ...args);
  }
  return spawn.call(this, program, ...args);
};
syncBuiltinESMExports();
