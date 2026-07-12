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
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

/** Executable extensions to try on Windows, in PATHEXT order, plus "" for extensionless files. */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  const exts = raw
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  return ["", ...exts];
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
 * directories are searched. On Windows, PATHEXT variants are tried in order. Returns `null`
 * when the command is not found on PATH (callers treat that as "not available", never as a
 * reason to fall back to a bare-name spawn).
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
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Options for {@link safeSpawn}. */
export interface SafeSpawnOptions extends ResolveOptions {
  stdio?: Parameters<typeof spawn>[2] extends { stdio?: infer S } ? S : unknown;
  detached?: boolean;
}

/**
 * Resolve `command` on PATH and spawn its absolute path (fire-and-forget friendly). Returns the
 * `ChildProcess`, or `null` if the command is not on PATH (the caller decides how to report a
 * missing CLI — this helper NEVER falls back to spawning a bare name, which is the whole point).
 *
 * The child's cwd is forced to a TRUSTED directory (the directory the resolved binary lives in —
 * a PATH location, never the inherited/attacker-controlled cwd) so a `.cmd` shim that itself
 * invokes a bare name (npm shims call `node`) can't be hijacked by a planted `node.exe` either.
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
  const stdio = options.stdio as never;

  if (platform === "win32" && needsShellToLaunch(absolute)) {
    // .cmd/.bat can't be spawned without a shell; go through cmd.exe with the fully-qualified
    // quoted path (no cwd-first lookup for an absolute path) + trusted cwd + windowsHide.
    const line = [absolute, ...args].map(quoteForShell).join(" ");
    return spawn(line, {
      shell: true,
      cwd: trustedCwd,
      windowsHide: true,
      stdio,
      ...(options.detached === true ? { detached: true } : {}),
    });
  }

  return spawn(absolute, args as string[], {
    cwd: trustedCwd,
    windowsHide: true,
    stdio,
    ...(options.detached === true ? { detached: true } : {}),
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
