/** GitHub Copilot CLI adapter status and diagnostics. */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";

import type { DetectionResult, DoctorResult, IntegrationStatus } from "@birdybeep/agent-core";
import { staleHookCommandPaths } from "@birdybeep/agent-core";

import { detectCopilot } from "./detect";
import { installedBirdyBeepCommands, isCurrentCopilotHooks } from "./install";
import { copilotHooksDir, copilotHooksPath, type CopilotPathOptions } from "./paths";

export const COPILOT_ADAPTER_VERSION = "0.0.0";

export interface CopilotStatusOptions extends CopilotPathOptions {
  detect?: () => Promise<DetectionResult>;
}

interface HookState {
  exists: boolean;
  parseable: boolean;
  current: boolean;
  /**
   * Absolute paths in the managed commands that no longer exist — the CLI moved, or the Node it
   * was installed under is gone (gcgp.9). Copilot fails these hooks with exit 127 and nothing
   * else looks wrong. The file carries a bash AND a powershell form of the same launcher, so the
   * paths are de-duplicated before they are reported.
   */
  stalePaths: string[];
}

function inspectHooks(options: CopilotPathOptions): HookState {
  const path = copilotHooksPath(options);
  if (!existsSync(path)) {
    return { exists: false, parseable: true, current: false, stalePaths: [] };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return {
      exists: true,
      parseable: true,
      current: isCurrentCopilotHooks(parsed),
      stalePaths: [
        ...new Set(
          installedBirdyBeepCommands(parsed).flatMap((command) =>
            staleHookCommandPaths(command, existsSync),
          ),
        ),
      ],
    };
  } catch {
    return { exists: true, parseable: false, current: false, stalePaths: [] };
  }
}

function resolveDetect(options: CopilotStatusOptions): Promise<DetectionResult> {
  return options.detect?.() ?? detectCopilot(options);
}

export async function copilotStatus(
  options: CopilotStatusOptions = {},
): Promise<IntegrationStatus> {
  const detection = await resolveDetect(options);
  if (!detection.detected) return "not_detected";
  const hooks = inspectHooks(options);
  if (!hooks.parseable) return "error";
  if (hooks.current) return "installed";
  if (hooks.exists) return "error";
  return "unknown";
}

export interface CopilotStatusReport {
  status: IntegrationStatus;
  harnessVersion?: string;
  adapterVersion: string;
}

export async function copilotStatusReport(
  options: CopilotStatusOptions = {},
): Promise<CopilotStatusReport> {
  const detection = await resolveDetect(options);
  const status = await copilotStatus({ ...options, detect: () => Promise.resolve(detection) });
  const report: CopilotStatusReport = { status, adapterVersion: COPILOT_ADAPTER_VERSION };
  if (detection.version !== undefined) report.harnessVersion = detection.version;
  return report;
}

export async function copilotDoctor(options: CopilotStatusOptions = {}): Promise<DoctorResult> {
  const detection = await resolveDetect(options);
  const checks: DoctorResult["checks"] = [];
  checks.push(
    detection.detected
      ? { name: "GitHub Copilot CLI installed", ok: true, status: "installed" }
      : {
          name: "GitHub Copilot CLI installed",
          ok: false,
          status: "not_detected",
          detail: "The `copilot` CLI and configuration directory were not found.",
          remedy: "Install GitHub Copilot CLI, then run `birdybeep agent install copilot`.",
        },
  );

  if (detection.detected) {
    const state = inspectHooks(options);
    const path = copilotHooksPath(options);
    checks.push(
      !state.parseable
        ? {
            name: "BirdyBeep hook file valid JSON",
            ok: false,
            status: "error",
            detail: `${path} is not valid JSON.`,
            remedy: "Repair or remove the file, then run `birdybeep agent install copilot`.",
          }
        : state.current
          ? { name: "BirdyBeep hooks installed", ok: true, status: "installed" }
          : {
              name: "BirdyBeep hooks installed",
              ok: false,
              status: state.exists ? "error" : "unknown",
              detail: state.exists
                ? "The dedicated BirdyBeep hook file has drifted from the current format."
                : "BirdyBeep's Copilot hook file is not installed.",
              remedy: "Run `birdybeep agent install copilot` to install the current hooks.",
            },
    );

    // gcgp.9 parity: a stale absolute path fails the hook with exit 127 and no other symptom —
    // the file still reads as correctly installed while it delivers nothing.
    if (state.exists && state.parseable) {
      checks.push(
        state.stalePaths.length === 0
          ? { name: "Hook command resolves", ok: true }
          : {
              name: "Hook command resolves",
              ok: false,
              status: "error",
              detail: `The installed hook command points at ${state.stalePaths.join(", ")}, which no longer exists. Copilot fails these hooks with exit 127.`,
              remedy:
                "Run `birdybeep agent install copilot` to rewrite the hook command for the current CLI.",
            },
      );
    }

    const writableTarget = existsSync(path) ? path : copilotHooksDir(options);
    let writable = true;
    try {
      if (existsSync(writableTarget)) accessSync(writableTarget, constants.W_OK);
    } catch {
      writable = false;
    }
    checks.push(
      writable
        ? { name: "Copilot hook path writable", ok: true }
        : {
            name: "Copilot hook path writable",
            ok: false,
            status: "error",
            detail: `${writableTarget} is not writable.`,
            remedy: "Fix file permissions so BirdyBeep can update the Copilot hook file.",
          },
    );
  }

  return { ok: checks.every((check) => check.ok), checks };
}
