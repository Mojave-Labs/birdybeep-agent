/**
 * Codex config locations, resolved HOME-relative and honoring `$CODEX_HOME` (Codex's
 * own config-home override), so a non-standard HOME (the E2E sandbox, or a real user)
 * works — never hard-coded `/Users/...`.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { MACOS_APPLICATIONS_DIR } from "@birdybeep/agent-core";

export const CODEX_DIR_NAME = ".codex";
export const CODEX_CONFIG_FILE = "config.toml";

export interface CodexPathOptions {
  /** Override the home dir (default `os.homedir()`). */
  home?: string;
  /** Explicit Codex config home (default `$CODEX_HOME`, else `~/.codex`). */
  codexHome?: string;
}

/** The Codex user config dir: `$CODEX_HOME` if set, else `~/.codex`. */
export function codexConfigDir(opts: CodexPathOptions = {}): string {
  const explicit = opts.codexHome ?? process.env["CODEX_HOME"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return join(opts.home ?? homedir(), CODEX_DIR_NAME);
}

/** The Codex config file (`config.toml`) the installer patches. */
export function codexConfigFile(opts: CodexPathOptions = {}): string {
  return join(codexConfigDir(opts), CODEX_CONFIG_FILE);
}

/** Bundle name of the ChatGPT desktop app, which ships and spawns its own Codex engine. */
export const CHATGPT_APP_BUNDLE = "ChatGPT.app";

export interface CodexDesktopOptions {
  /** Platform to resolve for (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** macOS applications directory (tests point this at a fixture). Default `/Applications`. */
  applicationsDir?: string;
}

/**
 * `/Applications/ChatGPT.app/Contents/Resources/codex` — the Codex build the ChatGPT desktop app
 * spawns (as `codex app-server`). It auto-updates with the app, independently of any `codex` on
 * PATH: 0.148.0-alpha.9 here against 0.135.0 and 0.147.0 there on the machine gcgp.6 landed on.
 * It reads the SAME `~/.codex/config.toml`, so one `agent install codex` covers it — what it does
 * not share is whether it has ever fired the hook.
 *
 * `null` off macOS: the ChatGPT desktop app's layout elsewhere is unobserved, and a guessed path
 * would report a surface that may not exist.
 */
export function chatgptDesktopCodexPath(options: CodexDesktopOptions = {}): string | null {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  return join(
    options.applicationsDir ?? MACOS_APPLICATIONS_DIR,
    CHATGPT_APP_BUNDLE,
    "Contents",
    "Resources",
    "codex",
  );
}
