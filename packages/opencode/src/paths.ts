/**
 * Cross-OS resolution of OpenCode's user-level config + plugin locations (§9.7).
 * VERIFIED against OpenCode docs + source (sst/opencode): the global config is
 * `opencode.json` (JSON/JSONC) under the XDG config dir (`$XDG_CONFIG_HOME/opencode`,
 * else `~/.config/opencode`); plugins auto-load from the `plugin/` directory beside it,
 * or from a top-level `"plugin"` array in opencode.json. Side-effect-free.
 *
 * Tests pass `home` (→ `<home>/.config/opencode`) for determinism; production with no
 * options honors the real `XDG_CONFIG_HOME` (and `%APPDATA%` on Windows). The Windows
 * default is best-effort — OpenCode's exact Windows path is unverified, so the CI
 * matrix exercises it rather than trusting a hard-coded guess.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenCodePathOptions {
  /** Test override: treat this as `$HOME` → resolves `<home>/.config/opencode`. */
  home?: string;
  /** Explicit XDG config base → resolves `<configHome>/opencode`. */
  configHome?: string;
}

/** OpenCode's user-level config directory (honors `XDG_CONFIG_HOME`; `~/.config/opencode` default). */
export function opencodeConfigDir(options: OpenCodePathOptions = {}): string {
  if (options.configHome !== undefined) return join(options.configHome, "opencode");
  if (options.home !== undefined) return join(options.home, ".config", "opencode");
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.length > 0) return join(xdg, "opencode");
  if (process.platform === "win32") {
    const appdata = process.env["APPDATA"];
    if (appdata !== undefined && appdata.length > 0) return join(appdata, "opencode");
  }
  return join(homedir(), ".config", "opencode");
}

/** OpenCode's global config file (`opencode.json`). */
export function opencodeConfigFile(options: OpenCodePathOptions = {}): string {
  return join(opencodeConfigDir(options), "opencode.json");
}

/** Directory OpenCode auto-loads plugin files from (`plugin/`, matching the `plugin` config key). */
export function opencodePluginDir(options: OpenCodePathOptions = {}): string {
  return join(opencodeConfigDir(options), "plugin");
}
