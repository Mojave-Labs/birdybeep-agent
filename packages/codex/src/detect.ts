/**
 * Codex detection (§9.6): is Codex present, what version, and where its user config
 * lives. Side-effect-free (no writes), HOME/$CODEX_HOME-relative, never throws —
 * absence returns a clean not-detected result so `agent install` can skip gracefully.
 */
import { existsSync } from "node:fs";

import { type DetectionResult, safeExecFile } from "@birdybeep/agent-core";

import { codexConfigDir, codexConfigFile, type CodexPathOptions } from "./paths";

/**
 * Best-effort `codex --version` probe; returns a version string or null (never throws).
 * SECURITY (sec-review-2026-07 M6): resolves `codex` to an ABSOLUTE path on PATH only via
 * `safeExecFile` — never the cwd. On Windows the OS resolves a bare name against the current
 * directory before PATH, so a repo shipping `codex.exe` at its root would otherwise run when
 * a dev invokes `birdybeep agent install/doctor` from inside it. `safeExecFile` returns null
 * (→ version unknown) when `codex` isn't on PATH; config-dir detection still applies.
 */
async function probeCodexVersion(): Promise<string | null> {
  try {
    const result = await safeExecFile("codex", ["--version"], { timeout: 2000 });
    if (result === null) return null;
    const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(result.stdout);
    if (match) return match[1] ?? null;
    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export interface CodexDetectOptions extends CodexPathOptions {
  /** Injectable version probe for deterministic tests. */
  probeVersion?: () => Promise<string | null>;
}

/** Detect Codex: present if its config dir exists OR a `codex` binary reports a version. */
export async function detectCodex(options: CodexDetectOptions = {}): Promise<DetectionResult> {
  const dirPresent = existsSync(codexConfigDir(options));
  const version = await (options.probeVersion ?? probeCodexVersion)();
  const detected = dirPresent || version !== null;

  if (!detected) {
    return {
      detected: false,
      detail: "Codex not found ($CODEX_HOME / ~/.codex missing and `codex` not on PATH)",
    };
  }
  const result: DetectionResult = { detected: true, configPath: codexConfigFile(options) };
  if (version !== null) result.version = version;
  return result;
}
