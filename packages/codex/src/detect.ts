/**
 * Codex detection (§9.6): is Codex present, what version, and where its user config
 * lives. Side-effect-free (no writes), HOME/$CODEX_HOME-relative, never throws —
 * absence returns a clean not-detected result so `agent install` can skip gracefully.
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

import {
  chatgptDesktopCodexPath,
  codexConfigDir,
  codexConfigFile,
  type CodexPathOptions,
} from "./paths";

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

export interface CodexDetectOptions extends CodexPathOptions, SurfaceProbeOptions {
  /** Injectable version probe for deterministic tests. */
  probeVersion?: () => Promise<string | null>;
}

/**
 * Every installed Codex BUILD on this machine (birdybeep-agent-gcgp.6), as surfaces:
 *
 *   - terminal — each `codex` on PATH. These are npm shims, so the owning package's
 *     `package.json` gives the exact version without running anything. Two at once is normal
 *     (one per Node install) and they drift, so every one is listed; only the first is what the
 *     user gets by typing `codex`.
 *   - desktop — the build inside ChatGPT.app. It keeps its version inside the binary, so the row
 *     carries none until an event from it arrives (`harness_version`, gcgp.7, reads it out of the
 *     rollout Codex writes) — which is the evidence that matters anyway.
 *
 * ALL of them share ONE `~/.codex/config.toml`: one `agent install codex` wires every row here,
 * and one uninstall unwires every row. Coverage differs only in what has actually fired.
 */
export function codexSurfaces(
  options: CodexDetectOptions & { probedVersion?: string | undefined } = {},
): HarnessSurface[] {
  const configPath = codexConfigFile(options);
  const surfaces: HarnessSurface[] = [];

  resolveAllOnPath("codex", options).forEach((enginePath, index) => {
    const version =
      engineVersionFromPath(enginePath) ??
      (index === 0 ? sanitizeHarnessVersion(options.probedVersion) : undefined);
    surfaces.push({
      id: index === 0 ? "terminal" : `terminal-${index + 1}`,
      kind: "terminal",
      label: index === 0 ? "terminal CLI" : "terminal CLI (shadowed on PATH)",
      ...(index === 0 ? {} : { shadowed: true }),
      ...(version !== undefined ? { version } : {}),
      enginePath,
      configPath,
    });
  });

  const bundled = chatgptDesktopCodexPath(options);
  if (bundled !== null && existsSync(bundled)) {
    surfaces.push({
      id: "desktop",
      kind: "desktop",
      label: "ChatGPT desktop app",
      enginePath: bundled,
      configPath,
    });
  }

  return surfaces;
}

/**
 * Detect Codex: present if its config dir exists OR a `codex` binary reports a version.
 *
 * Surfaces (birdybeep-agent-gcgp.6) ride along on a positive detection but never CAUSE one — see
 * the note in the Claude Code adapter: PATH and `/Applications` ignore a `home` override.
 */
export async function detectCodex(options: CodexDetectOptions = {}): Promise<DetectionResult> {
  const dirPresent = existsSync(codexConfigDir(options));
  const version = await (options.probeVersion ?? probeCodexVersion)();
  if (!(dirPresent || version !== null)) {
    return {
      detected: false,
      surfaces: [],
      detail: "Codex not found ($CODEX_HOME / ~/.codex missing and `codex` not on PATH)",
    };
  }
  const result: DetectionResult = {
    detected: true,
    configPath: codexConfigFile(options),
    surfaces: codexSurfaces({ ...options, probedVersion: version ?? undefined }),
  };
  if (version !== null) result.version = version;
  return result;
}
