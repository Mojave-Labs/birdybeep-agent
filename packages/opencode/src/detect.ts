/**
 * OpenCode detection (§9.7): is OpenCode present, what version, and where its user
 * config lives. Side-effect-free (no writes), HOME/XDG-relative, never throws — absence
 * returns a clean not-detected result so `agent install` can skip gracefully.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import type { DetectionResult } from "@birdybeep/agent-core";

import { opencodeConfigDir, opencodeConfigFile, type OpenCodePathOptions } from "./paths";

const execFileAsync = promisify(execFile);

/** Best-effort `opencode --version` probe; returns a version string or null (never throws). */
async function probeOpenCodeVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("opencode", ["--version"], { timeout: 2000 });
    const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(stdout);
    if (match) return match[1] ?? null;
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export interface OpenCodeDetectOptions extends OpenCodePathOptions {
  /** Injectable version probe for deterministic tests. */
  probeVersion?: () => Promise<string | null>;
}

/** Detect OpenCode: present if its config dir exists OR an `opencode` binary reports a version. */
export async function detectOpenCode(
  options: OpenCodeDetectOptions = {},
): Promise<DetectionResult> {
  const dirPresent = existsSync(opencodeConfigDir(options));
  const version = await (options.probeVersion ?? probeOpenCodeVersion)();
  const detected = dirPresent || version !== null;

  if (!detected) {
    return {
      detected: false,
      detail: "OpenCode not found (~/.config/opencode missing and `opencode` not on PATH)",
    };
  }
  const result: DetectionResult = { detected: true, configPath: opencodeConfigFile(options) };
  if (version !== null) result.version = version;
  return result;
}
