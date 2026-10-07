import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("prepare installs an independent, idempotent hook that blocks a real push on failure", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "birdybeep-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, ".githooks"));
  copyFileSync(
    new URL("./install-hooks.mjs", import.meta.url),
    join(repo, "scripts/install-hooks.mjs"),
  );
  copyFileSync(new URL("../.githooks/pre-push", import.meta.url), join(repo, ".githooks/pre-push"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Hook test");
  git("config", "user.email", "hook-test@example.invalid");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  writeFileSync(
    join(repo, "scripts/pre-push.mjs"),
    `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync("hook-observation.json", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), refs: readFileSync(0, "utf8") }));
process.exit(17);
`,
  );
  const install = () =>
    execFileSync(process.execPath, [join(repo, "scripts/install-hooks.mjs")], { cwd: dir, env });
  install();
  install();
  assert.equal(git("config", "--local", "core.hooksPath"), ".githooks");
  git("add", ".");
  git("commit", "-m", "Install hook fixture");
  const blocked = spawnSync("git", ["push", "origin", "main"], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  assert.notEqual(blocked.status, 0, blocked.stdout + blocked.stderr);
  assert.equal(git("ls-remote", "origin", "refs/heads/main"), "");
  const observed = JSON.parse(readFileSync(join(repo, "hook-observation.json"), "utf8"));
  assert.equal(realpathSync(observed.cwd), realpathSync(repo));
  assert.deepEqual(observed.args, ["origin", remote]);
  assert.match(observed.refs, /^refs\/heads\/main [a-f0-9]+ refs\/heads\/main 0+\n$/);
  writeFileSync(join(repo, "scripts/pre-push.mjs"), "process.exit(0);\n");
  git("push", "origin", "main");
  assert.match(git("ls-remote", "origin", "refs/heads/main"), /refs\/heads\/main$/);
});
