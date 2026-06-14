/**
 * Claude Code detection (§9.5): is Claude Code present, what version, and which
 * user settings file would the installer patch. Side-effect-free (no writes, no
 * network) and HOME-relative, so `agent install all` can skip-on-absent and the
 * temp-HOME E2E works. Never throws — absence returns a clean not-detected result.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";

import type { DetectionResult } from "@birdybeep/agent-core";

import { claudeConfigDir, claudeSettingsPath } from "./paths";

const execFileAsync = promisify(execFile);

/** Best-effort `claude --version` probe; returns a version string or null (never throws). */
async function probeClaudeVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 2000 });
    const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(stdout);
    if (match) return match[1] ?? null;
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null; // not on PATH / errored → absent, not fatal
  }
}

export interface DetectOptions {
  /** Override the home dir (default `os.homedir()`, which honors `$HOME`). */
  home?: string;
  /** Injectable version probe for deterministic tests. */
  probeVersion?: () => Promise<string | null>;
}

/** Detect Claude Code: present if `~/.claude` exists OR a `claude` binary reports a version. */
export async function detectClaudeCode(options: DetectOptions = {}): Promise<DetectionResult> {
  const home = options.home ?? homedir();
  const dirPresent = existsSync(claudeConfigDir(home));
  const version = await (options.probeVersion ?? probeClaudeVersion)();
  const detected = dirPresent || version !== null;

  if (!detected) {
    return {
      detected: false,
      detail: "Claude Code not found (~/.claude missing and `claude` not on PATH)",
    };
  }
  const result: DetectionResult = { detected: true, configPath: claudeSettingsPath(home) };
  if (version !== null) result.version = version;
  return result;
}
