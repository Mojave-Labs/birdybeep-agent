/**
 * Harness SURFACES (birdybeep-agent-gcgp.6) — the per-BUILD view of a harness.
 *
 * A harness is not one program. Claude Code ships a terminal CLI on PATH *and* an engine the
 * Claude desktop app manages under its own Application Support directory. Codex ships an npm
 * CLI *and* a build bundled inside ChatGPT.app. Cursor ships `cursor-agent` *and* Cursor.app.
 * Each is a separate install on its own update channel and they drift — 2.1.227 vs 2.1.229 for
 * Claude Code, 0.135.0 vs 0.148.0-alpha.9 for Codex, on the machine this landed on. `detect()`
 * collapsed all of that into one boolean plus one version, so "the terminal CLI is wired" and
 * "the desktop app's engine is wired" were the same answer.
 *
 * Every probe in this module is FILESYSTEM ONLY. Spawning an engine to ask its version is not
 * side-effect-free in practice (a `cursor-agent --version` probe was observed writing a config
 * file), and a probe answers for whichever build is first on PATH — which erases the very split
 * this module exists to measure.
 *
 * PLATFORM: the desktop layouts below were observed on macOS. On Linux and Windows the desktop
 * probes return nothing rather than guessing a path — omitting a real surface is a smaller lie
 * than inventing a fake one, and it keeps `version` meaning "read off this machine".
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { sanitizeHarnessVersion } from "./harness-version";

/** Where a harness build runs from: a CLI the user types, or an engine a desktop app spawns. */
export const HARNESS_SURFACE_KINDS = ["terminal", "desktop"] as const;
export type HarnessSurfaceKind = (typeof HARNESS_SURFACE_KINDS)[number];

/** One installed build of a harness — a thing that can independently be covered, or not. */
export interface HarnessSurface {
  /** Stable id within the harness: `terminal`, `terminal-2`, `desktop`, `desktop-2`, … */
  id: string;
  kind: HarnessSurfaceKind;
  /** What to call it in `status` / `doctor`, e.g. "terminal CLI", "Claude desktop app". */
  label: string;
  /**
   * The build's version, when it can be read WITHOUT running the engine. Absent when only the
   * engine itself knows (the ChatGPT-bundled Codex keeps it inside the binary) — the version
   * then comes from an event the build actually fired, which is the stronger evidence anyway.
   */
  version?: string;
  /**
   * Another install of the same harness comes earlier on PATH, so typing the command never
   * reaches this one. It is still reported — PATH order changes, and a user who does not know
   * they have two installs cannot reason about the version they see — but it is not expected to
   * fire, so it is never graded as a coverage gap.
   */
  shadowed?: boolean;
  /** The binary (or app bundle) this surface runs. */
  enginePath: string;
  /**
   * The artifact that connects this surface to BirdyBeep — for most harnesses the config file
   * carrying our hook entries. OpenCode is the exception (gcgp.16): it writes no command into
   * harness config at all, and its plugin spawns an absolute launcher argv recorded in the user
   * data dir, so that record is what its surfaces point at.
   */
  configPath: string;
}

export interface SurfaceProbeOptions {
  /** Environment to read PATH from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Platform to probe for (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** macOS applications directory (tests point this at a fixture). Default `/Applications`. */
  applicationsDir?: string;
}

/** Where macOS keeps installed apps; overridable so the desktop probes are testable off-Mac. */
export const MACOS_APPLICATIONS_DIR = "/Applications";

export function applicationsDir(options: SurfaceProbeOptions = {}): string {
  return options.applicationsDir ?? MACOS_APPLICATIONS_DIR;
}

/** Desktop-app layouts are observed on macOS only; every other platform gets no desktop surface. */
export function desktopSurfacesSupported(options: SurfaceProbeOptions = {}): boolean {
  return (options.platform ?? process.platform) === "darwin";
}

/**
 * Split a path into segments, platform-correctly.
 *
 * Windows accepts BOTH `\` and `/` as separators, and a path can mix them — a `join`ed path uses
 * backslashes while a config value or a test fixture may use forward slashes, so splitting on
 * `path.sep` alone silently produced ONE segment and lost every version. POSIX is the opposite
 * case: `\` is a legal character IN a filename there, so splitting on it would corrupt a real
 * directory name. Same class as the gcgp.9 tokenizer bug — a separator assumption only one
 * platform ever sees.
 */
function pathSegments(path: string, platform: NodeJS.Platform): string[] {
  return path.split(platform === "win32" ? /[\\/]+/ : /\/+/);
}

/** Resolve symlinks, falling back to the original path (a broken link is not an error here). */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * `…/versions/2.1.227` or `…/versions/2026.07.09-a3815c0/cursor-agent` → the version segment.
 * Both the Claude Code and the cursor-agent installers lay their builds out this way, so the
 * terminal build's version is readable from the symlink alone — no `--version` spawn.
 *
 * The segment must actually LOOK like a version — digit-led and dotted. A `versions/` directory
 * is not proprietary: nvm's `~/.nvm/versions/node/v26.1.0/bin/codex` sits under one too, and
 * without this guard every npm-installed harness under nvm reported its version as `node`.
 */
const VERSIONED_SEGMENT_RE = /^\d[A-Za-z0-9.+-]*\.[A-Za-z0-9.+-]+$/;

export function versionFromVersionedPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const parts = pathSegments(path, platform);
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const segment = parts[i];
    if (parts[i - 1] !== "versions" || segment === undefined) continue;
    if (!VERSIONED_SEGMENT_RE.test(segment)) continue;
    const version = sanitizeHarnessVersion(segment);
    if (version !== undefined) return version;
  }
  return undefined;
}

/**
 * An npm-installed CLI's version, from the `package.json` of the package that owns the resolved
 * shim (`/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js` → 0.147.0). Only walks up
 * inside a `node_modules` tree, so an unrelated `package.json` further up can never be read as a
 * harness version.
 */
export function versionFromNodePackage(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const resolved = realOrSelf(binaryPath);
  if (!pathSegments(resolved, platform).includes("node_modules")) return undefined;
  let dir = dirname(resolved);
  for (let depth = 0; depth < 3; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof parsed === "object" && parsed !== null) {
          return sanitizeHarnessVersion((parsed as Record<string, unknown>)["version"]);
        }
      } catch {
        return undefined; // unreadable manifest → unknown, never a guess
      }
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * A macOS app bundle's version from its Electron payload manifest
 * (`Contents/Resources/app/package.json`). Info.plist is deliberately NOT consulted: for the
 * bundles that matter here it carries the SHELL app's version, not the agent engine's
 * (ChatGPT.app reports 26.810.52044 while the Codex it spawns is 0.148.0-alpha.9).
 */
export function versionFromAppBundle(appPath: string): string | undefined {
  const manifest = join(appPath, "Contents", "Resources", "app", "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      return sanitizeHarnessVersion((parsed as Record<string, unknown>)["version"]);
    }
  } catch {
    /* unreadable manifest → unknown */
  }
  return undefined;
}

/** Best-effort version of an engine binary from the filesystem alone; undefined when only it knows. */
export function engineVersionFromPath(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const resolved = realOrSelf(binaryPath);
  return versionFromVersionedPath(resolved, platform) ?? versionFromNodePackage(resolved, platform);
}

/**
 * Immediate subdirectories of `dir`, or `[]` when it is absent/unreadable. Used by the desktop
 * probes, which enumerate version-named build directories.
 */
export function childDirectories(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
