/**
 * Cross-OS resolution of the BirdyBeep user data / config directories. These live
 * in the user's profile (NEVER repo-local), honoring the platform conventions and
 * the env vars the E2E sandbox redirects (HOME, XDG_*, LOCALAPPDATA) so tests stay
 * hermetic:
 *   - Windows: %LOCALAPPDATA%\birdybeep
 *   - macOS:   ~/Library/Application Support/birdybeep
 *   - Linux:   $XDG_DATA_HOME|$XDG_CONFIG_HOME or ~/.local/share | ~/.config /birdybeep
 */
import { homedir } from "node:os";
import { join } from "node:path";

function baseDir(kind: "data" | "config"): string {
  const home = homedir();
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"];
    return local && local.length > 0 ? local : join(home, "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  const xdg = kind === "data" ? process.env["XDG_DATA_HOME"] : process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) return xdg;
  return join(home, kind === "data" ? join(".local", "share") : ".config");
}

/** Absolute path to the BirdyBeep user DATA dir (queue, caches). */
export function birdyBeepDataDir(): string {
  return join(baseDir("data"), "birdybeep");
}

/** Absolute path to the BirdyBeep user CONFIG dir (token store fallback). */
export function birdyBeepConfigDir(): string {
  return join(baseDir("config"), "birdybeep");
}
