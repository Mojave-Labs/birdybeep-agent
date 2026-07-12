/**
 * OpenCode detection (§9.7): is OpenCode present, what version, and where its user
 * config lives. Side-effect-free (no writes), HOME/XDG-relative, never throws — absence
 * returns a clean not-detected result so `agent install` can skip gracefully.
 */
import { existsSync } from "node:fs";

import { type DetectionResult, safeExecFile } from "@birdybeep/agent-core";

import { opencodeConfigDir, opencodeConfigFile, type OpenCodePathOptions } from "./paths";

/**
 * Best-effort `opencode --version` probe; returns a version string or null (never throws).
 * SECURITY (sec-review-2026-07 M6): resolves `opencode` to an ABSOLUTE path on PATH only via
 * `safeExecFile` — never the cwd. On Windows the OS resolves a bare name against the current
 * directory before PATH, so a repo shipping `opencode.exe` at its root would otherwise run when
 * a dev invokes `birdybeep agent install/doctor` from inside it. `safeExecFile` returns null
 * (→ version unknown) when `opencode` isn't on PATH; config-dir detection still applies.
 */
async function probeOpenCodeVersion(): Promise<string | null> {
  try {
    const result = await safeExecFile("opencode", ["--version"], { timeout: 2000 });
    if (result === null) return null;
    const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(result.stdout);
    if (match) return match[1] ?? null;
    const trimmed = result.stdout.trim();
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
