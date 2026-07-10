/**
 * detectRepoContext proof — pure filesystem git detection (no `git` subprocess).
 * Builds real `.git` layouts (normal repo, nested cwd, detached HEAD, linked
 * worktree, non-repo) in hermetic temp dirs and asserts the repo label + branch,
 * plus the fail-soft contract (never throws → `{}`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectRepoContext } from "./workspace";

const created: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-ws-"));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("detectRepoContext", () => {
  it("reports repo (working-tree dir name) + branch for a normal checkout", () => {
    const repo = join(tempRoot(), "myapp");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(detectRepoContext(repo)).toEqual({ repoName: "myapp", branch: "main" });
  });

  it("walks up from a nested cwd to the enclosing repo", () => {
    const repo = join(tempRoot(), "proj");
    const deep = join(repo, "packages", "api", "src");
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feature/login\n");
    expect(detectRepoContext(deep)).toEqual({ repoName: "proj", branch: "feature/login" });
  });

  it("omits branch on a detached HEAD (raw sha)", () => {
    const repo = join(tempRoot(), "detached");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "9f2c1ab0deadbeef0000000000000000cafef00d\n");
    expect(detectRepoContext(repo)).toEqual({ repoName: "detached" });
  });

  it("resolves a linked worktree (.git is a file: gitdir: …)", () => {
    const root = tempRoot();
    // Main repo holds the worktree's real git dir with its own HEAD.
    const mainGitWt = join(root, "main", ".git", "worktrees", "wt");
    mkdirSync(mainGitWt, { recursive: true });
    writeFileSync(join(mainGitWt, "HEAD"), "ref: refs/heads/wt-branch\n");
    // The worktree checkout: `.git` is a FILE pointing at that dir.
    const wt = join(root, "myapp-wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${mainGitWt}\n`);
    expect(detectRepoContext(wt)).toEqual({ repoName: "myapp-wt", branch: "wt-branch" });
  });

  it("returns {} outside any repo, and never throws on bad input", () => {
    const plain = join(tempRoot(), "no-repo");
    mkdirSync(plain, { recursive: true });
    expect(detectRepoContext(plain)).toEqual({});
    expect(detectRepoContext("")).toEqual({});
    // An absolute path that does not exist walks to root and finds nothing — no throw.
    expect(detectRepoContext(join(tempRoot(), "does", "not", "exist"))).toEqual({});
  });
});
