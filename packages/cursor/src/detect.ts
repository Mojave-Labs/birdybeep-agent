/**
 * Cursor detection (§9.x): is Cursor present, what version, and which hooks file
 * would the installer patch. Side-effect-free (no writes, no network) and
 * HOME-relative, so `agent install all` can skip-on-absent and the temp-HOME E2E
 * works. Never throws — absence returns a clean not-detected result.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { type DetectionResult, safeExecFile } from "@birdybeep/agent-core";

import { cursorConfigDir, cursorHooksPath } from "./paths";

/**
 * Best-effort `cursor-agent --version` probe; returns a version string or null (never throws).
 * SECURITY (sec-review-2026-07 M6): resolves `cursor-agent` to an ABSOLUTE path on PATH only via
 * `safeExecFile` — never the cwd. On Windows the OS resolves a bare name against the current
 * directory before PATH, so a repo shipping `cursor-agent.exe` at its root would otherwise run
 * when a dev invokes `birdybeep agent install/doctor` from inside it. `safeExecFile` returns null
 * (→ version unknown) when `cursor-agent` isn't on PATH; config-dir detection still applies.
 */
async function probeCursorVersion(): Promise<string | null> {
  try {
    const result = await safeExecFile("cursor-agent", ["--version"], { timeout: 2000 });
    if (result === null) return null; // not on PATH → absent, not fatal
    const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(result.stdout);
    if (match) return match[1] ?? null;
    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null; // errored → absent, not fatal
  }
}

export interface DetectOptions {
  /** Override the home dir (default `os.homedir()`, which honors `$HOME`). */
  home?: string;
  /** Injectable version probe for deterministic tests. */
  probeVersion?: () => Promise<string | null>;
}

/** Detect Cursor: present if `~/.cursor` exists OR a `cursor-agent` binary reports a version. */
export async function detectCursor(options: DetectOptions = {}): Promise<DetectionResult> {
  const home = options.home ?? homedir();
  const dirPresent = existsSync(cursorConfigDir(home));
  const version = await (options.probeVersion ?? probeCursorVersion)();
  const detected = dirPresent || version !== null;

  if (!detected) {
    return {
      detected: false,
      detail: "Cursor not found (~/.cursor missing and `cursor-agent` not on PATH)",
    };
  }
  const result: DetectionResult = { detected: true, configPath: cursorHooksPath(home) };
  if (version !== null) result.version = version;
  return result;
}
