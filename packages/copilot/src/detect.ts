/** Side-effect-free GitHub Copilot CLI detection. */
import { existsSync } from "node:fs";

import { type DetectionResult, safeExecFile } from "@birdybeep/agent-core";

import { copilotConfigDir, copilotHooksPath, type CopilotPathOptions } from "./paths";

async function probeCopilotVersion(): Promise<string | null> {
  try {
    const result = await safeExecFile("copilot", ["--version"], { timeout: 2000 });
    if (result === null) return null;
    const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(result.stdout);
    if (match) return match[1] ?? null;
    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export interface DetectCopilotOptions extends CopilotPathOptions {
  probeVersion?: () => Promise<string | null>;
}

export async function detectCopilot(options: DetectCopilotOptions = {}): Promise<DetectionResult> {
  const configPresent = existsSync(copilotConfigDir(options));
  const version = await (options.probeVersion ?? probeCopilotVersion)();
  if (!configPresent && version === null) {
    return {
      detected: false,
      detail: "GitHub Copilot CLI not found (~/.copilot missing and `copilot` not on PATH)",
    };
  }

  const result: DetectionResult = { detected: true, configPath: copilotHooksPath(options) };
  if (version !== null) result.version = version;
  return result;
}
