/**
 * Claude Code config locations, resolved HOME-relative so a non-standard `$HOME`
 * (the E2E sandbox, or a real user) is honored — never hard-coded `/Users/...`.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_DIR_NAME = ".claude";
export const SETTINGS_FILE = "settings.json";

/** `~/.claude` — the Claude Code user config directory. */
export function claudeConfigDir(home: string = homedir()): string {
  return join(home, CLAUDE_DIR_NAME);
}

/** `~/.claude/settings.json` — the user-level settings file the installer patches. */
export function claudeSettingsPath(home: string = homedir()): string {
  return join(claudeConfigDir(home), SETTINGS_FILE);
}
