// Installed by the root prepare script. The verification gate is owned by this repo.
import { execFileSync } from "node:child_process";
import { chmodSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const checkout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (relative(realpathSync.native(checkout), realpathSync.native(root)) !== "") process.exit(0);
} catch {
  // Source archives and published packages do not have a Git checkout.
  process.exit(0);
}
chmodSync(new URL("../.githooks/pre-push", import.meta.url), 0o755);
execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], { cwd: root });
console.error("birdybeep: installed .githooks/pre-push verification gate");
