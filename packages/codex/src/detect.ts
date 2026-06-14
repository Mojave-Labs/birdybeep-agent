/**
 * Codex detection (§9.6): is Codex present, what version, and where its user config
 * lives. Side-effect-free (no writes), HOME/$CODEX_HOME-relative, never throws —
 * absence returns a clean not-detected result so `agent install` can skip gracefully.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import type { DetectionResult } from "@birdybeep/agent-core";

import { codexConfigDir, codexConfigFile, type CodexPathOptions } from "./paths";

const execFileAsync = promisify(execFile);

/** Best-effort `codex --version` probe; returns a version string or null (never throws). */
async function probeCodexVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("codex", ["--version"], { timeout: 2000 });
    const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(stdout);
    if (match) return match[1] ?? null;
    const trimmed = stdout.trim();
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
