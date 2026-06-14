/**
 * Codex config locations, resolved HOME-relative and honoring `$CODEX_HOME` (Codex's
 * own config-home override), so a non-standard HOME (the E2E sandbox, or a real user)
 * works — never hard-coded `/Users/...`.
 */
import { homedir } from "node:os";
import { join } from "node:path";

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
