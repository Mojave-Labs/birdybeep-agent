/**
 * Cursor config locations, resolved HOME-relative so a non-standard `$HOME`
 * (the E2E sandbox, or a real user) is honored — never hard-coded `/Users/...`.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const CURSOR_DIR_NAME = ".cursor";
export const HOOKS_FILE = "hooks.json";

/** `~/.cursor` — the Cursor user config directory. */
export function cursorConfigDir(home: string = homedir()): string {
  return join(home, CURSOR_DIR_NAME);
}

/** `~/.cursor/hooks.json` — the user-level hooks file the installer patches. */
export function cursorHooksPath(home: string = homedir()): string {
  return join(cursorConfigDir(home), HOOKS_FILE);
}
