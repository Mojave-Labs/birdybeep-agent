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

/** The Claude desktop app's data directory name under `~/Library/Application Support`. */
export const CLAUDE_DESKTOP_DIR_NAME = "Claude";
/** Subdirectory holding the claude-code engine builds the desktop app manages. */
export const CLAUDE_DESKTOP_ENGINE_DIR_NAME = "claude-code";

export interface ClaudeDesktopOptions {
  /** Override the home dir (default `os.homedir()`, which honors `$HOME`). */
  home?: string;
  /** Platform to resolve for (default `process.platform`). */
  platform?: NodeJS.Platform;
}

/**
 * `~/Library/Application Support/Claude/claude-code` — where the Claude desktop app keeps the
 * claude-code builds it spawns (`<version>/claude.app/Contents/MacOS/claude`). This is a wholly
 * separate update channel from the terminal CLI on PATH: 2.1.229 here against 2.1.227 there on
 * the machine gcgp.6 landed on.
 *
 * `null` off macOS. The desktop app ships for other platforms but its engine layout there is
 * unobserved, and a guessed path would report a surface that may not exist — worse than
 * reporting none (birdybeep-agent-gcgp.6).
 */
export function claudeDesktopEngineRoot(options: ClaudeDesktopOptions = {}): string | null {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  return join(
    options.home ?? homedir(),
    "Library",
    "Application Support",
    CLAUDE_DESKTOP_DIR_NAME,
    CLAUDE_DESKTOP_ENGINE_DIR_NAME,
  );
}

/** The engine binary inside one managed build directory. */
export function claudeDesktopEngineBinary(root: string, version: string): string {
  return join(root, version, "claude.app", "Contents", "MacOS", "claude");
}
