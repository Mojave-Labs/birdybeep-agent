/**
 * Cursor detection (§9.x): is Cursor present, what version, and which hooks file
 * would the installer patch. Side-effect-free (no writes, no network) and
 * HOME-relative, so `agent install all` can skip-on-absent and the temp-HOME E2E
 * works. Never throws — absence returns a clean not-detected result.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import {
  type DetectionResult,
  engineVersionFromPath,
  type HarnessSurface,
  resolveAllOnPath,
  safeExecFile,
  sanitizeHarnessVersion,
  type SurfaceProbeOptions,
  versionFromAppBundle,
} from "@birdybeep/agent-core";

import { cursorConfigDir, cursorDesktopAppPath, cursorHooksPath } from "./paths";

/**
 * Best-effort `cursor-agent --version` probe; returns a version string or null (never throws).
 * SECURITY (sec-review-2026-07 M6): resolves `cursor-agent` to an ABSOLUTE path on PATH only via
 * `safeExecFile` — never the cwd. On Windows the OS resolves a bare name against the current
 * directory before PATH, so a repo shipping `cursor-agent.exe` at its root would otherwise run
 * when a dev invokes `birdybeep agent install/doctor` from inside it. `safeExecFile` returns null
 * (→ version unknown) when `cursor-agent` isn't on PATH; config-dir detection still applies.
 */
async function probeCursorVersion(): Promise<string | null> {
  try {
    const result = await safeExecFile("cursor-agent", ["--version"], { timeout: 2000 });
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
 * Every installed Cursor BUILD on this machine (birdybeep-agent-gcgp.6), as surfaces:
 *
 *   - terminal — each `cursor-agent` on PATH. Its installer symlinks into
 *     `~/.local/share/cursor-agent/versions/<version>/cursor-agent`, so the version comes off the
 *     link. Never probed with `--version`: that spawn was observed writing a Cursor config file,
 *     which is exactly the side effect these probes must not have.
 *   - desktop — Cursor.app, versioned by its own Electron manifest.
 *
 * Both read `~/.cursor/hooks.json`, so one `agent install cursor` wires both rows.
 */
export function cursorSurfaces(
  options: DetectOptions & { probedVersion?: string | undefined } = {},
): HarnessSurface[] {
  const home = options.home ?? homedir();
  const configPath = cursorHooksPath(home);
  const surfaces: HarnessSurface[] = [];

  resolveAllOnPath("cursor-agent", options).forEach((enginePath, index) => {
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

  const app = cursorDesktopAppPath(options);
  if (app !== null && existsSync(app)) {
    const version = versionFromAppBundle(app);
    surfaces.push({
      id: "desktop",
      kind: "desktop",
      label: "Cursor desktop app",
      ...(version !== undefined ? { version } : {}),
      enginePath: app,
      configPath,
    });
  }

  return surfaces;
}

/**
 * Detect Cursor: present if `~/.cursor` exists OR a `cursor-agent` binary reports a version.
 *
 * Surfaces (birdybeep-agent-gcgp.6) ride along on a positive detection but never CAUSE one — see
 * the note in the Claude Code adapter: PATH and `/Applications` ignore a `home` override.
 */
export async function detectCursor(options: DetectOptions = {}): Promise<DetectionResult> {
  const home = options.home ?? homedir();
  const dirPresent = existsSync(cursorConfigDir(home));
  const version = await (options.probeVersion ?? probeCursorVersion)();
  if (!(dirPresent || version !== null)) {
    return {
      detected: false,
      surfaces: [],
      detail: "Cursor not found (~/.cursor missing and `cursor-agent` not on PATH)",
    };
  }
  const result: DetectionResult = {
    detected: true,
    configPath: cursorHooksPath(home),
    surfaces: cursorSurfaces({ ...options, probedVersion: version ?? undefined }),
  };
  if (version !== null) result.version = version;
  return result;
}
