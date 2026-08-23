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

/** Longest one-line completion body composed here, before the normalizer's own caps take over. */
const SUMMARY_MAX_CHARS = 200;

/**
 * Condense a harness's final assistant message into a one-line push body, so the beep says WHAT
 * finished rather than only that something did (§10.2).
 *
 * Heuristic: the first non-empty line — agents lead with the headline — whitespace-collapsed and
 * truncated. `undefined` for an absent/blank message so the caller falls back to generic copy.
 * Path/secret scrubbing stays the normalizer's job.
 *
 * SHARED because it was Claude Code's alone (birdybeep-agent-2ep), which is the whole reason a
 * Claude beep read "fixed the failing auth test" while a Codex beep read "Turn complete". The
 * PRIVACY LINE this sits on: a title/body is never PERSISTED or LOGGED server-side, and Private
 * Mode redacts it at dispatch from the event category without ever reading it. Putting the
 * message in the body a user is about to read on their own phone is not the thing that rule
 * forbids — Claude Code has done exactly this since §10.2 and it is why its beeps are useful.
 */
export function summarizeLastMessage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  const collapsed = firstLine.replace(/\s+/g, " ");
  return collapsed.length > SUMMARY_MAX_CHARS
    ? `${collapsed.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : collapsed;
}

/**
 * `"<repo> · <branch>"` (or just `"<repo>"`) to lead a push title; `undefined` when the cwd is
 * not a checkout. Shared so every adapter labels a beep the same way — it was duplicated in three
 * and missing from two (birdybeep-agent-2ep).
 */
export function repoLabel(ctx: RepoContext): string | undefined {
  if (!ctx.repoName) return undefined;
  return ctx.branch ? `${ctx.repoName} · ${ctx.branch}` : ctx.repoName;
}
