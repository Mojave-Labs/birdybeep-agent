/**
 * Local git workspace detection (§10.2 workspace context). Walks up from a cwd to
 * the enclosing git working tree and reports a human repo label + current branch,
 * so an event can name WHICH checkout produced it (the disambiguator when several
 * agent sessions run at once). Pure filesystem reads — no `git` subprocess — so it
 * is fast enough for the hook path and works even when git isn't on PATH. Handles
 * linked worktrees, where `.git` is a FILE (`gitdir: …`) rather than a directory.
 *
 * Best-effort and fail-soft by contract: every failure collapses to `{}` and it
 * NEVER throws into a hook fire. The raw cwd is not returned (only the basename
 * label + branch); path hashing of cwd still happens in the normalizer.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface RepoContext {
  /** Human label for the checkout — the working-tree directory name (distinct per worktree). */
  repoName?: string;
  /** Current branch, or undefined when detached / undeterminable. */
  branch?: string;
}

/** Read the branch from a `.git/HEAD` payload (`ref: refs/heads/<branch>`); undefined when detached. */
function branchFromHead(headContents: string): string | undefined {
  return /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(headContents)?.[1];
}

/**
 * Resolve the real git directory for a working tree whose `.git` entry is `gitEntry`.
 * Usually `.git` is a directory; in a linked worktree it's a FILE containing
 * `gitdir: <path>` that points at `…/.git/worktrees/<name>` (where HEAD lives).
 */
function resolveGitDir(gitEntry: string): string | undefined {
  try {
    const st = statSync(gitEntry);
    if (st.isDirectory()) return gitEntry;
    if (st.isFile()) {
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitEntry, "utf8"))?.[1];
      if (gitdir) return resolve(dirname(gitEntry), gitdir);
    }
  } catch {
    /* fall through to undefined */
  }
  return undefined;
}

/**
 * Best-effort {@link RepoContext} for an absolute `cwd`: the enclosing working-tree
 * directory name + current branch. Returns `{}` when `cwd` isn't inside a git repo
 * or anything goes wrong. Never throws.
 */
export function detectRepoContext(cwd: string): RepoContext {
  try {
    if (!cwd) return {};
    let dir = resolve(cwd);
    for (;;) {
      const gitEntry = join(dir, ".git");
      if (existsSync(gitEntry)) {
        const gitDir = resolveGitDir(gitEntry);
        let branch: string | undefined;
        if (gitDir) {
          try {
            branch = branchFromHead(readFileSync(join(gitDir, "HEAD"), "utf8"));
          } catch {
            /* HEAD unreadable → leave branch undefined */
          }
        }
        return branch ? { repoName: basename(dir), branch } : { repoName: basename(dir) };
      }
      const parent = dirname(dir);
      if (parent === dir) return {}; // reached filesystem root, no repo found
      dir = parent;
    }
  } catch {
    return {};
  }
}
