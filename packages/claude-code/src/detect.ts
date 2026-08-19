/**
 * Claude Code detection (§9.5): is Claude Code present, what version, and which
 * user settings file would the installer patch. Side-effect-free (no writes, no
 * network) and HOME-relative, so `agent install all` can skip-on-absent and the
 * temp-HOME E2E works. Never throws — absence returns a clean not-detected result.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import {
  childDirectories,
  type DetectionResult,
  engineVersionFromPath,
  type HarnessSurface,
  resolveAllOnPath,
  safeExecFile,
  sanitizeHarnessVersion,
  type SurfaceProbeOptions,
} from "@birdybeep/agent-core";

import {
  claudeConfigDir,
  claudeDesktopEngineBinary,
  claudeDesktopEngineRoot,
  claudeSettingsPath,
} from "./paths";

/**
 * Best-effort `claude --version` probe; returns a version string or null (never throws).
 * SECURITY (sec-review-2026-07 M6): resolves `claude` to an ABSOLUTE path on PATH only via
 * `safeExecFile` — never the cwd. On Windows the OS resolves a bare name against the current
 * directory before PATH, so a repo shipping `claude.exe` at its root would otherwise run when
 * a dev invokes `birdybeep agent install/doctor` from inside it. `safeExecFile` returns null
 * (→ version unknown) when `claude` isn't on PATH; config-dir detection still applies.
 */
async function probeClaudeVersion(): Promise<string | null> {
  try {
    const result = await safeExecFile("claude", ["--version"], { timeout: 2000 });
    if (result === null) return null; // not on PATH → absent, not fatal
    const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(result.stdout);
    if (match) return match[1] ?? null;
    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null; // errored → absent, not fatal
  }
}

export interface DetectOptions extends SurfaceProbeOptions {
  /** Override the home dir (default `os.homedir()`, which honors `$HOME`). */
  home?: string;
  /** Injectable version probe for deterministic tests. */
  probeVersion?: () => Promise<string | null>;
}

/**
 * Every installed Claude Code BUILD on this machine (birdybeep-agent-gcgp.6), as surfaces:
 *
 *   - terminal — each `claude` on PATH. The standard installer symlinks it at
 *     `~/.local/bin/claude` into `~/.local/share/claude/versions/<version>`, so the build's
 *     version is readable from the link alone. Where it is not, the first entry falls back to
 *     `probedVersion` — that probe resolves through PATH, so it describes exactly this surface.
 *   - desktop — each `<version>/claude.app/Contents/MacOS/claude` the Claude desktop app manages.
 *     The directory IS the version; nothing is executed to learn it.
 *
 * Both read the same `~/.claude/settings.json`, so one `agent install claude` wires every row —
 * what differs between them is whether the build has ever actually fired the hook.
 */
export function claudeCodeSurfaces(
  options: DetectOptions & { probedVersion?: string | undefined } = {},
): HarnessSurface[] {
  const home = options.home ?? homedir();
  const configPath = claudeSettingsPath(home);
  const surfaces: HarnessSurface[] = [];

  const onPath = resolveAllOnPath("claude", options);
  onPath.forEach((enginePath, index) => {
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

  const root = claudeDesktopEngineRoot(options);
  if (root !== null) {
    const builds = childDirectories(root)
      .map((name) => ({ name, version: sanitizeHarnessVersion(name) }))
      .filter((entry) => entry.version !== undefined)
      .filter((entry) => existsSync(claudeDesktopEngineBinary(root, entry.name)))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    builds.forEach((entry, index) => {
      surfaces.push({
        id: index === 0 ? "desktop" : `desktop-${index + 1}`,
        kind: "desktop",
        label: "Claude desktop app",
        ...(entry.version !== undefined ? { version: entry.version } : {}),
        enginePath: claudeDesktopEngineBinary(root, entry.name),
        configPath,
      });
    });
  }

  return surfaces;
}

/**
 * Detect Claude Code: present if `~/.claude` exists OR a `claude` binary reports a version.
 *
 * Surfaces (birdybeep-agent-gcgp.6) ride along on a positive detection but never CAUSE one. They
 * are read off PATH and `/Applications`, neither of which a `home` override redirects, so letting
 * them decide `detected` would make every temp-HOME sandbox see the real machine.
 */
export async function detectClaudeCode(options: DetectOptions = {}): Promise<DetectionResult> {
  const home = options.home ?? homedir();
  const dirPresent = existsSync(claudeConfigDir(home));
  const version = await (options.probeVersion ?? probeClaudeVersion)();
  if (!(dirPresent || version !== null)) {
    return {
      detected: false,
      surfaces: [],
      detail: "Claude Code not found (~/.claude missing and `claude` not on PATH)",
    };
  }
  const result: DetectionResult = {
    detected: true,
    configPath: claudeSettingsPath(home),
    surfaces: claudeCodeSurfaces({ ...options, probedVersion: version ?? undefined }),
  };
  if (version !== null) result.version = version;
  return result;
}
