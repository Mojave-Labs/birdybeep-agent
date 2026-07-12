/**
 * Safe process launch for adapters (§security / sec-review-2026-07 H1/M6).
 *
 * The threat this closes: spawning a BARE program name (e.g. `birdybeep`, `codex`) lets the
 * OS resolve it. On Windows, both `cmd.exe` (used by `shell: true`) and libuv (used by a
 * plain `execFile`/`spawn` of a name that has no path separator) search the CURRENT WORKING
 * DIRECTORY *before* PATH, applying PATHEXT (.COM/.EXE/.BAT/.CMD). Because these adapters run
 * inside a coding harness whose cwd is the repo the developer just opened, a hostile repo that
 * ships `birdybeep.exe` / `codex.cmd` at its root gets ARBITRARY CODE EXECUTION the moment a
 * lifecycle event fires — no prompt. (POSIX is not vulnerable: PATH search never includes cwd
 * unless `.` is literally on PATH, which we also refuse below.)
 *
 * The fix is to never hand a bare name to the OS resolver: {@link resolveOnPath} finds the
 * command's ABSOLUTE path by scanning PATH *only* (never cwd), and the spawn helpers launch
 * that absolute path. Where a Windows shim is a `.cmd`/`.bat` — which Node ≥20 refuses to run
 * without a shell (CVE-2024-27980 hardening) — we go through the shell with the fully-qualified,
 * quoted path plus an explicit TRUSTED cwd and `windowsHide`, so `cmd.exe` does no cwd-first
 * lookup (an absolute path is unambiguous) and any bare-name lookup the shim itself performs
 * resolves against a trusted directory rather than the attacker's repo.
 *
 * Delivering the event payload to the launched CLI's STDIN (`safeSpawn`'s `input`): on POSIX and a
 * Windows `.exe` we pipe it straight to the child's stdin (a direct spawn, no intermediary shell).
 * But piping into a Windows `.cmd` through `cmd.exe` (`shell: true`) is unreliable — the parent's
 * write to `child.stdin` does not dependably reach the batch file's `node` grandchild, so the
 * payload (and its EOF) is lost and every OpenCode event silently dropped on Windows. For that
 * case we instead write the payload to a strict-perm (0o600) temp file and redirect the shell's
 * stdin FROM it (`... < "file"`): cmd.exe opens the file itself — no fragile pipe hand-off — and
 * the payload never rides the command line, so no argument quoting/length limit applies. The temp
 * file is deleted when the child exits. Either way the CLI's "read stdin to EOF" contract holds.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Injectable OS surface so the Windows resolution logic is unit-testable off Windows. */
export interface ResolveOptions {
  /** Environment to read PATH / PATHEXT from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Platform to resolve for (default `process.platform`). */
  platform?: NodeJS.Platform;
}

/**
 * Executable extensions to try on Windows, in PATHEXT order.
 *
 * We deliberately do NOT include the empty extension "". On Windows a bare-name command is
 * resolved via PATHEXT, and an extensionless file is not directly launchable by CreateProcess
 * (nor picked up by cmd.exe's bare-name lookup) anyway. Preferring "" caused a real functional
 * regression: a standard npm global install co-locates an extensionless `birdybeep` (a
 * `#!/bin/sh` wrapper for MSYS/Git-Bash) with `birdybeep.cmd` and `birdybeep.ps1` in the SAME
 * on-PATH directory. Resolving the extensionless sh wrapper made `needsShellToLaunch` false, so
 * the spawn tried to launch it WITHOUT a shell — which Windows CreateProcess cannot do with a
 * shebang script — silently dropping every OpenCode event and degrading version detection to
 * "unknown". Trying the real PATHEXT extensions first picks `birdybeep.cmd`, which IS launchable
 * (via the shell), matching how Windows actually resolves a bare command name.
 */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

/**
 * Is `candidate` an existing, launchable file for this platform?
 *
 * On POSIX we mirror `execvp`: a PATH entry that exists but is NOT executable (e.g. a data
 * file, or a name earlier on PATH the user lacks +x on) is skipped so the search continues to a
 * later directory that holds the real executable — returning the non-executable hit would make
 * the subsequent spawn fail with EACCES even though a runnable binary exists further down PATH.
 * On Windows there is no exec bit (runnability is governed by PATHEXT, handled above), and
 * `X_OK` collapses to a mere existence check, so we keep a plain existence test there. Assumes a
 * non-root caller on POSIX (root's `access(X_OK)` succeeds regardless of the mode bits — same as
 * the OS, so this can never be *less* correct than a bare existence check).
 */
function isLaunchableFile(candidate: string, isWindows: boolean): boolean {
  if (!existsSync(candidate)) return false;
  if (isWindows) return true;
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH directories, in order. Reads `PATH` then `Path` (a plain injected env is case-sensitive). */
function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  const raw = env["PATH"] ?? env["Path"] ?? "";
  return raw.split(delimiter).filter((d) => d.length > 0);
}

/** Does this resolved absolute path need a shell to launch (a Windows batch shim)? */
export function needsShellToLaunch(absolutePath: string): boolean {
  const lower = absolutePath.toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

/** Quote a token for a `cmd.exe` command line (our tokens never contain quotes, but be safe). */
function quoteForShell(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Resolve a BARE command name to an ABSOLUTE path by searching PATH ONLY — never the current
 * working directory. This is the core of the CWD-binary-planting fix: relative PATH entries
 * (including a literal `.`) resolve against cwd, so they are skipped; only absolute PATH
 * directories are searched. On Windows, PATHEXT variants are tried in order (NOT the bare
 * extensionless name — see {@link windowsExtensions}); on POSIX only the bare name, and a
 * non-executable hit is skipped like `execvp` would. Returns `null` when the command is not
 * found on PATH (callers treat that as "not available", never as a reason to fall back to a
 * bare-name spawn).
 */
export function resolveOnPath(command: string, options: ResolveOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isWindows = platform === "win32";
  const extensions = isWindows ? windowsExtensions(env) : [""];

  for (const dir of pathDirectories(env)) {
    // A relative PATH entry (e.g. ".", "bin", "..\\x") resolves against the inherited cwd —
    // exactly the hijack vector. Refuse it; only absolute PATH directories are trusted.
    if (!isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (isLaunchableFile(candidate, isWindows)) return candidate;
    }
  }
  return null;
}

/** Options for {@link safeSpawn}. */
export interface SafeSpawnOptions extends ResolveOptions {
  stdio?: Parameters<typeof spawn>[2] extends { stdio?: infer S } ? S : unknown;
  detached?: boolean;
  /**
   * Data to deliver to the launched CLI's STDIN. Delivered via a strict-perm temp file the child
   * reads (an inherited read fd on POSIX / a Windows `.exe`; a `< "file"` shell redirection for a
   * Windows `.cmd`/`.bat`), NOT a parent-held pipe — piping into `cmd.exe` does not reliably reach
   * a batch shim's `node` grandchild. When set, `stdio` is managed by this helper and ignored.
   */
  input?: string;
}

/**
 * Write `data` to a fresh strict-perm (0o600) temp file and return its path. The payload is the
 * pre-redaction event envelope (no durable token — the CLI reads the token from its secure store
 * at send time), but 0o600 keeps it owner-only while it briefly exists on a shared machine.
 */
function writeStdinTempFile(data: string): string {
  const file = join(tmpdir(), `birdybeep-hook-${randomBytes(16).toString("hex")}.json`);
  writeFileSync(file, data, { mode: 0o600 });
  return file;
}

/** Best-effort deletion of a delivery temp file; never throws (cleanup must not break delivery). */
function unlinkQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* the OS reclaims tmp eventually; a failed unlink must never surface */
  }
}

/**
 * Resolve `command` on PATH and spawn its absolute path (fire-and-forget friendly). Returns the
 * `ChildProcess`, or `null` if the command is not on PATH (the caller decides how to report a
 * missing CLI — this helper NEVER falls back to spawning a bare name, which is the whole point).
 *
 * The child's cwd is forced to a TRUSTED directory (the directory the resolved binary lives in —
 * a PATH location, never the inherited/attacker-controlled cwd) so a `.cmd` shim that itself
 * invokes a bare name (npm shims call `node`) can't be hijacked by a planted `node.exe` either.
 *
 * Pass `options.input` to deliver a stdin payload reliably across platforms (see the interface
 * doc and the file header): it is written to a strict-perm temp file the child reads, cleaned up
 * on exit — never piped through `cmd.exe`, where the bytes can silently fail to reach the shim.
 */
export function safeSpawn(
  command: string,
  args: readonly string[],
  options: SafeSpawnOptions = {},
): ChildProcess | null {
  const platform = options.platform ?? process.platform;
  const absolute = resolveOnPath(command, options);
  if (absolute === null) return null;

  const trustedCwd = dirname(absolute);
  const detachedOpt = options.detached === true ? { detached: true } : {};
  const needsShell = platform === "win32" && needsShellToLaunch(absolute);

  if (options.input !== undefined) {
    if (needsShell) {
      // Windows `.cmd`/`.bat`: a stdin PIPE written by the parent does NOT reliably reach the
      // batch shim's `node` grandchild through cmd.exe — the payload (and its EOF) is silently
      // lost, dropping every OpenCode event on Windows. Instead write the payload to a strict-perm
      // temp file and redirect the shell's stdin FROM it (`... < "file"`); cmd.exe opens the file
      // itself, so no fragile pipe/console hand-off. The payload never rides the command line, so
      // no cmd.exe argument quoting/length limit applies. The file is deleted when the child exits.
      const file = writeStdinTempFile(options.input);
      const line = `${[absolute, ...args].map(quoteForShell).join(" ")} < ${quoteForShell(file)}`;
      // NOTE: do NOT pass `detached` here. On Windows a DETACHED cmd.exe launched with `shell:true`
      // + `stdio: 'ignore'` does not deliver the `< file` redirect to the batch shim's node
      // grandchild (windows-latest: every event dropped), whereas a non-detached shell spawn does.
      // We don't need detachment: the child is short-lived, `unref()`d by the caller so it never
      // blocks the harness, and on Windows a child is not killed when its parent exits anyway.
      const child = spawn(line, {
        shell: true,
        cwd: trustedCwd,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.once("exit", () => unlinkQuietly(file));
      child.once("error", () => unlinkQuietly(file));
      return child;
    }

    // POSIX / Windows `.exe`: pipe the payload straight to the child's stdin (the proven path —
    // no intermediary shell to lose the bytes). Swallow an EPIPE if the child died early; the
    // caller also listens for 'error'. This never blocks the harness: the write is fire-and-forget.
    const child = spawn(absolute, args as string[], {
      cwd: trustedCwd,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      ...detachedOpt,
    });
    child.stdin?.on("error", () => {
      /* child exited before we finished writing — best-effort, never throw */
    });
    try {
      child.stdin?.end(options.input);
    } catch {
      /* stdin already torn down; the event is simply dropped */
    }
    return child;
  }

  const stdio = options.stdio as never;

  if (needsShell) {
    // .cmd/.bat can't be spawned without a shell; go through cmd.exe with the fully-qualified
    // quoted path (no cwd-first lookup for an absolute path) + trusted cwd + windowsHide.
    const line = [absolute, ...args].map(quoteForShell).join(" ");
    return spawn(line, {
      shell: true,
      cwd: trustedCwd,
      windowsHide: true,
      stdio,
      ...detachedOpt,
    });
  }

  return spawn(absolute, args as string[], {
    cwd: trustedCwd,
    windowsHide: true,
    stdio,
    ...detachedOpt,
  });
}

/** Options for {@link safeExecFile}. */
export interface SafeExecFileOptions extends ResolveOptions {
  timeout?: number;
  maxBuffer?: number;
}

/**
 * Resolve `command` on PATH and `execFile` its absolute path, returning `{ stdout, stderr }`,
 * or `null` if the command is not on PATH. Used for read-only probes (e.g. `--version`).
 * Same trusted-path guarantee as {@link safeSpawn}: never runs a cwd-planted binary. On Windows
 * a `.cmd`/`.bat` shim is run through the shell with a quoted absolute path + trusted cwd so a
 * batch-shim harness still yields its version instead of failing.
 */
export async function safeExecFile(
  command: string,
  args: readonly string[],
  options: SafeExecFileOptions = {},
): Promise<{ stdout: string; stderr: string } | null> {
  const platform = options.platform ?? process.platform;
  const absolute = resolveOnPath(command, options);
  if (absolute === null) return null;

  const trustedCwd = dirname(absolute);
  const common = {
    timeout: options.timeout ?? 2000,
    windowsHide: true,
    cwd: trustedCwd,
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
  };

  if (platform === "win32" && needsShellToLaunch(absolute)) {
    const line = [absolute, ...args].map(quoteForShell).join(" ");
    return execFileAsync(line, [], { ...common, shell: true });
  }
  return execFileAsync(absolute, args as string[], common);
}
