/**
 * OpenCode detection (§9.7): is OpenCode present, what version, and where its user
 * config lives. Side-effect-free (no writes), HOME/XDG-relative, never throws — absence
 * returns a clean not-detected result so `agent install` can skip gracefully.
 */
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

import { type OpenCodeLauncherOptions, opencodeLauncherPath } from "./install";
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

export interface OpenCodeDetectOptions
  extends OpenCodePathOptions, SurfaceProbeOptions, OpenCodeLauncherOptions {
  /** Injectable version probe for deterministic tests. */
  probeVersion?: () => Promise<string | null>;
}

/**
 * Installed OpenCode BUILDS (birdybeep-agent-gcgp.6) — terminal only. OpenCode ships a desktop
 * app, but nothing has been observed about which engine it spawns or whether that engine loads
 * the plugin from `~/.config/opencode/plugin`, so no desktop surface is reported rather than a
 * guessed one. OpenCode also reports no `harness_version` yet (gcgp.7), so its events count as
 * unversioned: they prove the harness fired, not which build did.
 *
 * Unlike every other adapter these surfaces point at the LAUNCHER RECORD, not a harness config
 * file (gcgp.16): install writes no command into OpenCode's config — it records an absolute argv
 * the plugin spawns directly — so the launcher record is what stands between a surface and a beep.
 */
export function opencodeSurfaces(
  options: OpenCodeDetectOptions & { probedVersion?: string | undefined } = {},
): HarnessSurface[] {
  const configPath = opencodeLauncherPath(options);
  return resolveAllOnPath("opencode", options).map((enginePath, index) => {
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
      surfaces: [],
      detail: "OpenCode not found (~/.config/opencode missing and `opencode` not on PATH)",
    };
  }
  const result: DetectionResult = {
    detected: true,
    configPath: opencodeConfigFile(options),
    surfaces: opencodeSurfaces({ ...options, probedVersion: version ?? undefined }),
  };
  if (version !== null) result.version = version;
  return result;
}
