// Installed by prepare. The shared hook runs the verification script in the checkout being pushed.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
try {
  const checkout = git("rev-parse", "--show-toplevel");
  if (relative(realpathSync.native(checkout), realpathSync.native(root)) !== "") process.exit(0);
} catch {
  // Source archives and published packages do not have a Git checkout.
  process.exit(0);
}
// core.hooksPath is shared by linked worktrees. Keep the hook available to older
// checkouts too; it still executes each checkout's own scripts/pre-push.mjs.
const hooks = join(resolve(root, git("rev-parse", "--git-common-dir")), "birdybeep-hooks");
mkdirSync(hooks, { recursive: true });
const prePush = join(hooks, "pre-push");
copyFileSync(new URL("../.githooks/pre-push", import.meta.url), prePush);
chmodSync(prePush, 0o755);
git("config", "--local", "core.hooksPath", hooks);
console.error("birdybeep: installed shared pre-push verification gate");
