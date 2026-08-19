/**
 * How a harness config invokes `birdybeep hook <harness>` (birdybeep-agent-gcgp.9).
 *
 * A bare `birdybeep …` command only works when the harness happens to run hooks with the
 * user's shell PATH. GUI harnesses do not: Cursor executes hooks through the Electron main
 * process, whose PATH is the launchd environment (`/usr/bin:/bin:/usr/sbin:/sbin`), so a
 * globally installed CLI under `~/.local/bin`, a version manager, or pnpm's global bin dir
 * is invisible and the hook dies with `zsh:1: command not found: birdybeep` (exit 127).
 *
 * Writing only the CLI's absolute path is NOT enough either: the published bin is a Node
 * script whose shebang is `#!/usr/bin/env node`, so the same missing PATH makes it fail with
 * `env: node: No such file or directory` — also exit 127. The launcher therefore names BOTH
 * absolutes: the Node that is running the installer (`process.execPath`) and the CLI entry it
 * was started from (`process.argv[1]`).
 *
 * Absolute paths go stale (reinstall elsewhere, switch Node versions), so
 * {@link staleHookCommandPaths} lets `doctor` spot a broken command and tell the user to
 * re-run install, which rewrites the entry in place.
 *
 * Resolution is deliberately conservative — override, then the running CLI, then the portable
 * bare command. There is no PATH scan: guessing a `birdybeep` that is not the one being run
 * would silently pin a different install.
 *
 * QUOTING SEMANTICS — {@link shellQuote} and {@link tokenizeCommand} MUST agree, per platform,
 * because we write a command string and later read our own paths back out of it:
 *
 *   POSIX  the harness runs the command through `sh`/`zsh -c`. Inside double quotes those shells
 *          honor `\` as an escape before exactly `\ " $` and a backtick, and treat it as a
 *          LITERAL character before anything else. shellQuote escapes exactly that set, and the
 *          tokenizer un-escapes exactly that set.
 *   win32  `cmd.exe` and PowerShell do NOT treat `\` as an escape inside double quotes — it is an
 *          ordinary path separator. A literal quote is written by doubling it (`""`). So on
 *          Windows the tokenizer never consumes a backslash.
 *
 * Getting this wrong is not cosmetic (gcgp.9 follow-up): a tokenizer that ate `\` everywhere
 * turned `"C:\Users\x\npm\birdybeep.cmd"` into `C:UsersxnpmbirdybeepG.cmd`, which made
 * {@link hookCommandPaths} report a healthy command as stale AND made
 * {@link isBirdyBeepHookCommand} fail to recognize our own entry — so `doctor` flagged every
 * correct Windows install and `install` would have appended a duplicate hook instead of
 * rewriting in place.
 *
 * The POSIX branch is additionally chosen so a Windows-shaped path survives it unharmed
 * (`\h`, `\U`, `\n` … are not POSIX escapes). That is defence in depth only — the `platform`
 * argument is what makes UNC paths (`\\server\share`) and `C:\$Recycle.Bin` correct.
 *
 * POWERSHELL (birdybeep-agent-gcgp.16) — Copilot's hook schema carries a SEPARATE `powershell`
 * form, and neither of the rules above fits it, so it has its own quoter:
 *
 *   - A PowerShell command line that STARTS with a quoted string is parsed in expression mode:
 *     `"C:\node.exe" hook copilot …` prints the path instead of running it. The call operator
 *     `&` is required, hence {@link powershellLauncher}.
 *   - PowerShell interpolates `$…` and honors a backtick escape inside DOUBLE quotes, so
 *     double-quoting a real path is unsafe — `"C:\$Recycle.Bin\node.exe"` expands `$Recycle`
 *     to nothing. Single quotes are fully literal there (a literal `'` is written `''`), so
 *     {@link powershellQuote} single-quotes and {@link tokenizeCommand} understands single-
 *     quoted regions on every platform (POSIX `sh` reads them the same way).
 */
import { basename, isAbsolute } from "node:path";

/** The published CLI's bin name. */
export const BIRDYBEEP_COMMAND_NAME = "birdybeep";

/**
 * Escape hatch: an explicit launcher (everything before `hook <harness>`), e.g.
 * `BIRDYBEEP_HOOK_COMMAND="mise exec -- birdybeep"`. Read at install time only.
 */
export const HOOK_COMMAND_ENV_VAR = "BIRDYBEEP_HOOK_COMMAND";

/** Where a resolved launcher came from (surfaced by `doctor`, never sent anywhere). */
export type HookLauncherSource = "override" | "runtime" | "bare";

export interface HookLauncher {
  /** Shell-ready prefix, e.g. `"/abs/node" "/abs/birdybeep"` or `birdybeep`. */
  readonly launcher: string;
  readonly source: HookLauncherSource;
  /**
   * The launcher's UNQUOTED argv, when we built it ourselves (`runtime` → `[node, cliEntry]`,
   * `bare` → `["birdybeep"]`). Absent for an `override`, whose value is a raw shell string we
   * pass through verbatim and must never re-quote or re-interpret.
   *
   * Consumers that cannot use a shell string need this: the PowerShell quoter re-quotes the
   * parts (gcgp.16), and the OpenCode plugin spawns them directly with no shell at all.
   */
  readonly argv?: readonly string[];
}

export interface ResolveHookLauncherOptions {
  env?: Record<string, string | undefined>;
  /** The Node binary running the installer (default `process.execPath`). */
  execPath?: string;
  /** The installer's argv (default `process.argv`). */
  argv?: readonly string[];
  platform?: NodeJS.Platform;
}

/** The portable fallback: a bare command, resolved by the harness's own PATH. */
export const BARE_HOOK_LAUNCHER: HookLauncher = {
  launcher: BIRDYBEEP_COMMAND_NAME,
  source: "bare",
  argv: [BIRDYBEEP_COMMAND_NAME],
};

const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".cmd", ".exe", ".bat", ".ps1"];

/** Absolute on EITHER platform — a config written on Windows is still read on Windows only, but
 * the check must not depend on which host is parsing it (tests, cross-platform CI). */
function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function stripScriptExtension(name: string): string {
  const lower = name.toLowerCase();
  for (const ext of SCRIPT_EXTENSIONS) {
    if (lower.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

/**
 * Is this argv[1] the BirdyBeep CLI? Strict on purpose: a loose match would let a test
 * runner's entry point (or any path that merely contains "birdybeep", such as a checkout
 * directory) masquerade as the CLI and get baked into a user's harness config.
 */
export function isBirdyBeepCliEntry(entryPath: string | undefined): boolean {
  if (entryPath === undefined || entryPath.length === 0) return false;
  const normalized = entryPath.replace(/\\/g, "/");
  // npm/pnpm/yarn bin shim, invoked as `birdybeep` (argv[1] keeps the invoked path).
  if (stripScriptExtension(basename(normalized)) === BIRDYBEEP_COMMAND_NAME) return true;
  // Windows `birdybeep.cmd` re-invokes node with the package entry: .../@birdybeep/cli/dist/bin.js
  return normalized.includes("/@birdybeep/cli/");
}

/** Quote one argument for the shell the harness runs hooks through. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `"${value.replace(/"/g, '""')}"`;
  return `"${value.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

/**
 * Quote one argument for PowerShell (gcgp.16). Single quotes, because a PowerShell
 * double-quoted string interpolates `$…` and honors a backtick escape — a real path like
 * `C:\$Recycle.Bin\node.exe` would silently lose `$Recycle`. Inside single quotes nothing is
 * special and a literal `'` is written by doubling it.
 */
export function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The PowerShell form of a resolved launcher (gcgp.16), for a harness whose hook schema carries
 * a separate `powershell` command — GitHub Copilot CLI's does.
 *
 * A quoted path must be invoked with the call operator `&`: PowerShell parses a line that begins
 * with a quoted string in EXPRESSION mode and would just echo the path instead of running it. A
 * bare command name needs no `&` (and reads better without one), and an `override` is a raw shell
 * string the user wrote — passed through untouched, exactly as the POSIX form does.
 */
export function powershellLauncher(launcher: HookLauncher): string {
  if (launcher.argv === undefined) return launcher.launcher; // override: verbatim, never re-quoted
  if (launcher.source === "bare") return launcher.launcher;
  return `& ${launcher.argv.map(powershellQuote).join(" ")}`;
}

/** Resolve the launcher to write into a harness config. Never throws. */
export function resolveHookLauncher(options: ResolveHookLauncherOptions = {}): HookLauncher {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const override = env[HOOK_COMMAND_ENV_VAR]?.trim();
  if (override !== undefined && override.length > 0) {
    return { launcher: override, source: "override" };
  }

  const argv = options.argv ?? process.argv;
  const execPath = options.execPath ?? process.execPath;
  const entry = argv[1] ?? "";
  if (isBirdyBeepCliEntry(entry) && isAbsolutePath(entry) && isAbsolutePath(execPath)) {
    // Both absolute: immune to the harness's PATH and to the bin's `env node` shebang.
    return {
      launcher: `${shellQuote(execPath, platform)} ${shellQuote(entry, platform)}`,
      source: "runtime",
      argv: [execPath, entry],
    };
  }

  return BARE_HOOK_LAUNCHER;
}

/** The full managed command for one harness, e.g. `birdybeep hook cursor`. */
export function hookCommand(
  harness: string,
  args: readonly string[] = [],
  launcher: string = BARE_HOOK_LAUNCHER.launcher,
): string {
  return [launcher, "hook", harness, ...args].join(" ");
}

/** The managed command for this machine (resolved launcher + `hook <harness>`). */
export function resolveHookCommand(
  harness: string,
  args: readonly string[] = [],
  options: ResolveHookLauncherOptions = {},
): string {
  return hookCommand(harness, args, resolveHookLauncher(options).launcher);
}

/** The only characters a POSIX shell un-escapes after `\` inside double quotes. */
const POSIX_ESCAPABLE = new Set(["\\", '"', "$", "`"]);

/**
 * Split a command string into tokens, honoring double quotes — the inverse of
 * {@link shellQuote} for `platform`. See the file header for why the escape rules differ by
 * platform; the default is the host, which is always the machine that owns the config.
 */
export function tokenizeCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const windows = platform === "win32";
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  /** Inside a SINGLE-quoted region: fully literal, `''` is one `'` (PowerShell and POSIX sh). */
  let singleQuoted = false;
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];
    // Single quotes suppress every other rule, so handle the region first (gcgp.16). Nothing
    // inside is escaped or interpolated — that is exactly why powershellQuote uses them.
    if (singleQuoted) {
      if (char === "'") {
        if (next === "'") {
          current += "'"; // a literal quote is written by doubling it
          i += 1;
          continue;
        }
        singleQuoted = false;
        continue;
      }
      current += char;
      continue;
    }
    // POSIX only, and only for the four characters a shell actually un-escapes: everywhere else
    // `\` is a literal character (crucially, a Windows path separator).
    if (!windows && char === "\\" && quoted && next !== undefined && POSIX_ESCAPABLE.has(next)) {
      current += next;
      i += 1;
      continue;
    }
    // A `'` inside DOUBLE quotes is an ordinary character (a path may legitimately contain one),
    // so only an unquoted `'` opens a literal region.
    if (char === "'" && !quoted) {
      singleQuoted = true;
      started = true;
      continue;
    }
    if (char === '"') {
      if (windows && quoted && next === '"') {
        current += '"'; // cmd/PowerShell write a literal quote as ""
        i += 1;
        continue;
      }
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (started || current.length > 0) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
  }
  if (started || current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Is this command one of ours for `harness`? Shape-tolerant BY DESIGN: the same entry may
 * have been written as a bare command by an older install, or with a since-moved absolute
 * path, and install/uninstall/status must still recognize (and repair or remove) it. Requires
 * BOTH a token that names the BirdyBeep CLI and the exact trailing `hook <harness> [args]`,
 * so a third party's unrelated hook is never claimed.
 */
export function isBirdyBeepHookCommand(
  command: unknown,
  harness: string,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (typeof command !== "string") return false;
  const tokens = tokenizeCommand(command, platform);
  const tail = ["hook", harness, ...args];
  if (tokens.length < tail.length + 1) return false;
  const suffix = tokens.slice(tokens.length - tail.length);
  if (suffix.some((token, i) => token !== tail[i])) return false;
  return tokens
    .slice(0, tokens.length - tail.length)
    .some((token) => isBirdyBeepCliEntry(token) || token === BIRDYBEEP_COMMAND_NAME);
}

/** The absolute paths a command depends on (empty for the portable bare form). */
export function hookCommandPaths(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return tokenizeCommand(command, platform).filter(isAbsolutePath);
}

/**
 * Which of a command's absolute paths no longer exist — i.e. why the hook would fail with
 * exit 127. Empty for a healthy command and for the bare form (whose failure mode is PATH,
 * not a stale path, and which install replaces anyway).
 */
export function staleHookCommandPaths(
  command: string,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return hookCommandPaths(command, platform).filter((path) => !exists(path));
}
