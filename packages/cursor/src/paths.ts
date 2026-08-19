/**
 * Cursor config locations, resolved HOME-relative so a non-standard `$HOME`
 * (the E2E sandbox, or a real user) is honored — never hard-coded `/Users/...`.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { MACOS_APPLICATIONS_DIR } from "@birdybeep/agent-core";

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

/** Bundle name of the Cursor desktop app, which reads the same `~/.cursor/hooks.json`. */
export const CURSOR_APP_BUNDLE = "Cursor.app";

export interface CursorDesktopOptions {
  /** Platform to resolve for (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** macOS applications directory (tests point this at a fixture). Default `/Applications`. */
  applicationsDir?: string;
}

/**
 * `/Applications/Cursor.app` — the Cursor desktop app. It runs its own bundled agent against the
 * same `~/.cursor/hooks.json` the standalone `cursor-agent` CLI reads, on a different release
 * train: 3.15.6 here against 2026.07.09-a3815c0 there on the machine gcgp.6 landed on.
 *
 * `null` off macOS: Cursor's install layout elsewhere is unobserved.
 */
export function cursorDesktopAppPath(options: CursorDesktopOptions = {}): string | null {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  return join(options.applicationsDir ?? MACOS_APPLICATIONS_DIR, CURSOR_APP_BUNDLE);
}
