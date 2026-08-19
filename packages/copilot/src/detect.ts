/** Side-effect-free GitHub Copilot CLI detection. */
import { existsSync } from "node:fs";

import {
  type DetectionResult,
  engineVersionFromPath,
  type HarnessSurface,
  resolveAllOnPath,
  safeExecFile,
  sanitizeHarnessVersion,
  type SurfaceProbeOptions,
} from "@birdybeep/agent-core";

import { copilotConfigDir, copilotHooksPath, type CopilotPathOptions } from "./paths";

async function probeCopilotVersion(): Promise<string | null> {
  try {
    const result = await safeExecFile("copilot", ["--version"], { timeout: 2000 });
    if (result === null) return null;
    // Trailing `.`/`-` excluded: the real CLI prints "1.0.78." and the sentence's full stop was
    // being reported as part of the version (birdybeep-agent-gcgp.6).
    const match = /(\d+\.\d+\.\d+(?:[\w.-]*[\w])?)/.exec(result.stdout);
    if (match) return match[1] ?? null;
    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export interface DetectCopilotOptions extends CopilotPathOptions, SurfaceProbeOptions {
  probeVersion?: () => Promise<string | null>;
}

/**
 * Installed Copilot CLI BUILDS (birdybeep-agent-gcgp.6) — terminal only. GitHub ships Copilot in
 * editors, but nothing has been observed about an editor-bundled engine reading
 * `~/.copilot/hooks`, so no desktop surface is invented for it.
 */
export function copilotSurfaces(
  options: DetectCopilotOptions & { probedVersion?: string | undefined } = {},
): HarnessSurface[] {
  const configPath = copilotHooksPath(options);
  return resolveAllOnPath("copilot", options).map((enginePath, index) => {
    const version =
      engineVersionFromPath(enginePath) ??
      (index === 0 ? sanitizeHarnessVersion(options.probedVersion) : undefined);
    return {
      id: index === 0 ? "terminal" : `terminal-${index + 1}`,
      kind: "terminal" as const,
      label: index === 0 ? "terminal CLI" : "terminal CLI (shadowed on PATH)",
      ...(index === 0 ? {} : { shadowed: true }),
      ...(version !== undefined ? { version } : {}),
      enginePath,
      configPath,
    };
  });
}

export async function detectCopilot(options: DetectCopilotOptions = {}): Promise<DetectionResult> {
  const configPresent = existsSync(copilotConfigDir(options));
  const version = await (options.probeVersion ?? probeCopilotVersion)();
  if (!configPresent && version === null) {
    return {
      detected: false,
      surfaces: [],
      detail: "GitHub Copilot CLI not found (~/.copilot missing and `copilot` not on PATH)",
    };
  }

  const result: DetectionResult = {
    detected: true,
    configPath: copilotHooksPath(options),
    surfaces: copilotSurfaces({ ...options, probedVersion: version ?? undefined }),
  };
  if (version !== null) result.version = version;
  return result;
}
