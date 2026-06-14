/**
 * Hermetic temp-HOME sandbox. Every "where does my config / temp data live" env
 * var an adapter (or the CLI, or any tool it shells out to) might consult is
 * redirected into a throwaway directory, so an install can NEVER touch the real
 * machine — on macOS/Linux (HOME, XDG_*, TMPDIR) or Windows (USERPROFILE,
 * APPDATA, LOCALAPPDATA, TMP/TEMP). The original environment is captured and
 * restored on teardown, and the temp dir is removed on both success and failure.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Env vars that point tools at the user's home / config / data / temp dirs across
 * OSes. ALL are redirected into the sandbox so resolution is isolated regardless
 * of how a tool computes it (`os.homedir()`, `$HOME`, `%USERPROFILE%`, XDG,
 * `os.tmpdir()`/`$TMPDIR`/`%TEMP%`, …) — an adapter that writes to a "temp" or
 * "cache" dir therefore lands inside the sandbox and gets cleaned up too.
 */
const HOME_ENV_VARS = [
  "HOME", // macOS / Linux
  "USERPROFILE", // Windows (os.homedir uses this on win32)
  "HOMEPATH", // Windows (legacy)
  "XDG_CONFIG_HOME", // freedesktop config base
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "APPDATA", // Windows roaming app data
  "LOCALAPPDATA", // Windows local app data
  "TMPDIR", // macOS / Linux temp (os.tmpdir reads this)
  "TMP", // Windows temp
  "TEMP", // Windows temp
] as const;

export interface Sandbox {
  /** The throwaway home directory all isolated env vars point at. */
  readonly home: string;
  /** The user's REAL home dir (symlinks resolved), captured before isolation. */
  readonly realHome: string;
  /**
   * Build an absolute path inside the sandbox home. Rejects traversal (`..`) and
   * absolute segments so a test can't accidentally point writes outside the box.
   */
  path(...segments: string[]): string;
  /** Remove the sandbox dir and restore the original environment. Idempotent. */
  cleanup(): void;
}

/** Where each redirected env var should point inside the sandbox `home`. */
function sandboxEnvLayout(home: string): Record<(typeof HOME_ENV_VARS)[number], string> {
  return {
    HOME: home,
    USERPROFILE: home,
    HOMEPATH: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TMPDIR: join(home, ".tmp"),
    TMP: join(home, ".tmp"),
    TEMP: join(home, ".tmp"),
  };
}

/**
 * Create an isolated sandbox: a fresh temp dir with every home/config/temp env
 * var redirected into it. Call {@link Sandbox.cleanup} (or use
 * {@link withTempHome}) to restore the environment and delete the dir.
 */
export function createSandbox(prefix = "birdybeep-e2e-"): Sandbox {
  // Resolve symlinks so "untouched real home" checks compare canonical paths.
  let realHome: string;
  try {
    realHome = realpathSync(homedir());
  } catch {
    realHome = homedir();
  }
  // Created under the REAL tmpdir (before redirect), then TMPDIR is pointed inside.
  const home = mkdtempSync(join(tmpdir(), prefix));

  // Snapshot originals BEFORE mutating, so cleanup restores exactly (including
  // the "was unset" case — restoring means deleting, not setting to "").
  const original = new Map<string, string | undefined>();
  for (const key of HOME_ENV_VARS) {
    original.set(key, process.env[key]);
  }

  const layout = sandboxEnvLayout(home);
  for (const key of HOME_ENV_VARS) {
    const target = layout[key];
    process.env[key] = target;
    mkdirSync(target, { recursive: true });
  }

  let cleaned = false;
  return {
    home,
    realHome,
    path: (...segments: string[]) => {
      for (const seg of segments) {
        if (seg.split(/[\\/]/).includes("..") || isAbsolute(seg)) {
          throw new Error(
            `sandbox.path() rejects traversal/absolute segment: ${JSON.stringify(seg)}`,
          );
        }
      }
      return join(home, ...segments);
    },
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (existsSync(home)) rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Run `fn` inside a fresh sandbox, guaranteeing teardown on success or throw. */
export async function withTempHome<T>(fn: (sandbox: Sandbox) => Promise<T> | T): Promise<T> {
  const sandbox = createSandbox();
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}
