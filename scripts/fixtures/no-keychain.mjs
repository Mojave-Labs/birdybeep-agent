// Test process preload: a temp HOME alone does not isolate the per-user macOS Keychain.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const spawn = childProcess.spawn;
childProcess.spawn = function (program, ...args) {
  if (program === "/usr/bin/security" || program === "security") {
    throw Object.assign(new Error("Keychain disabled in isolated test process"), {
      code: "ENOENT",
    });
  }
  return spawn.call(this, program, ...args);
};
syncBuiltinESMExports();
