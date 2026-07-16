/**
 * OpenCode status() + doctor() (§8.8, §9.7). status() derives a §8.8 value from detection,
 * the state of `~/.config/opencode/opencode.json` (is the BirdyBeep plugin entry present?),
 * and the restart marker (has a real event been seen?). OpenCode is unique: writing the
 * plugin entry is NOT "installed" — the plugin loads only at startup, so we report
 * `needs_restart` until the first real event proves it loaded (OC-PLUGIN-PACKAGE). doctor()
 * diagnoses each failure mode with an actionable fix. Both are READ-ONLY.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import {
  type DetectionResult,
  type DoctorResult,
  getToken,
  type IntegrationStatus,
  type TokenStoreOptions,
} from "@birdybeep/agent-core";

import { detectOpenCode } from "./detect";
import { BIRDYBEEP_PLUGIN_REF, isBirdyBeepPluginConfigured } from "./install";
import { opencodeConfigDir, opencodeConfigFile } from "./paths";
import { hasOpenCodeEventBeenSeen, type OpenCodeRestartOptions } from "./restart";

/** Adapter version surfaced in the status report / backend integration record. */
export const OPENCODE_ADAPTER_VERSION = "0.0.0";

export interface OpenCodeStatusOptions extends OpenCodeRestartOptions {
  home?: string;
  /** Injectable detection for tests (avoids shelling out to `opencode --version`). */
  detect?: () => Promise<DetectionResult>;
  /** Token-store options for the "machine token resolvable" check (tests inject a backend). */
  tokenOptions?: TokenStoreOptions;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface ConfigState {
  exists: boolean;
  parseable: boolean;
  configured: boolean;
}

function inspectConfig(home: string): ConfigState {
  const path = opencodeConfigFile({ home });
  if (!existsSync(path)) return { exists: false, parseable: true, configured: false };
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { exists: true, parseable: false, configured: false };
  }
  return { exists: true, parseable: true, configured: isBirdyBeepPluginConfigured(parsed) };
}

function resolveDetect(opts: OpenCodeStatusOptions): Promise<DetectionResult> {
  if (opts.detect) return opts.detect();
  return detectOpenCode(opts.home !== undefined ? { home: opts.home } : {});
}

/** Current §8.8 integration status for OpenCode. */
export async function opencodeStatus(opts: OpenCodeStatusOptions = {}): Promise<IntegrationStatus> {
  const home = opts.home ?? homedir();
  const detection = await resolveDetect(opts);
  if (!detection.detected) return "not_detected";
  const config = inspectConfig(home);
  if (config.exists && !config.parseable) return "error"; // opencode.json is malformed
  if (config.configured) {
    // Restart-gated: installed only once a real event proves the plugin loaded.
    return hasOpenCodeEventBeenSeen(opts) ? "installed" : "needs_restart";
  }
  return "unknown"; // OpenCode present, BirdyBeep plugin not configured
}

export interface StatusReport {
  status: IntegrationStatus;
  harnessVersion?: string;
  adapterVersion: string;
}

/** status() + the versions the backend integration record / Integrations screen show. */
export async function opencodeStatusReport(
  opts: OpenCodeStatusOptions = {},
): Promise<StatusReport> {
  const detection = await resolveDetect(opts);
  const status = await opencodeStatus({ ...opts, detect: () => Promise.resolve(detection) });
  const report: StatusReport = { status, adapterVersion: OPENCODE_ADAPTER_VERSION };
  if (detection.version !== undefined) report.harnessVersion = detection.version;
  return report;
}

/** Diagnose OpenCode integration health with actionable fixes. */
export async function opencodeDoctor(opts: OpenCodeStatusOptions = {}): Promise<DoctorResult> {
  const home = opts.home ?? homedir();
  const detection = await resolveDetect(opts);
  const checks: DoctorResult["checks"] = [];

  // 1. OpenCode present?
  checks.push(
    detection.detected
      ? { name: "OpenCode installed", ok: true, status: "installed" }
      : {
          name: "OpenCode installed",
          ok: false,
          status: "not_detected",
          detail: "OpenCode was not found on this machine.",
          remedy: "Install OpenCode, then re-run `birdybeep agent install opencode`.",
        },
  );

  if (detection.detected) {
    const path = opencodeConfigFile({ home });
    const config = inspectConfig(home);

    // 2. opencode.json valid JSON?
    if (config.exists && !config.parseable) {
      checks.push({
        name: "opencode.json is valid JSON",
        ok: false,
        status: "error",
        detail: `${path} is not valid JSON.`,
        remedy: "Fix or remove the malformed opencode.json, then re-run install.",
      });
    } else {
      checks.push({ name: "opencode.json is valid JSON", ok: true });

      // 3. BirdyBeep plugin entry present?
      checks.push(
        config.configured
          ? { name: "BirdyBeep plugin configured", ok: true }
          : {
              name: "BirdyBeep plugin configured",
              ok: false,
              status: "unknown",
              detail: `The \`${BIRDYBEEP_PLUGIN_REF}\` plugin is not in opencode.json.`,
              remedy: "Run `birdybeep agent install opencode` to add the plugin.",
            },
      );

      // 4. Plugin loaded (restart done / a real event seen)?
      if (config.configured) {
        checks.push(
          hasOpenCodeEventBeenSeen(opts)
            ? { name: "OpenCode plugin loaded", ok: true, status: "installed" }
            : {
                name: "OpenCode plugin loaded",
                ok: false,
                status: "needs_restart",
                detail:
                  "The BirdyBeep plugin is configured but OpenCode has not sent an event yet.",
                remedy: "Restart OpenCode so it loads the BirdyBeep plugin.",
              },
        );
      }
    }

    // 5. config writable (a read-only file/dir blocks install/uninstall).
    const target = existsSync(path) ? path : opencodeConfigDir({ home });
    let writable = true;
    try {
      if (existsSync(target)) accessSync(target, constants.W_OK);
    } catch {
      writable = false;
    }
    checks.push(
      writable
        ? { name: "opencode.json writable", ok: true }
        : {
            name: "opencode.json writable",
            ok: false,
            status: "error",
            detail: `${target} is not writable.`,
            remedy: "Fix file permissions so BirdyBeep can update OpenCode config.",
          },
    );
  }

  // 6. Machine token resolvable?
  const token = await getToken(opts.tokenOptions ?? {});
  checks.push(
    token !== null && token.length > 0
      ? { name: "Machine token present", ok: true }
      : {
          name: "Machine token present",
          ok: false,
          status: "error",
          detail: "No BirdyBeep machine token found.",
          remedy: "Run `birdybeep pair` to pair this machine.",
        },
  );

  return { ok: checks.every((c) => c.ok), checks };
}
