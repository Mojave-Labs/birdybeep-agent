/** GitHub Copilot CLI adapter status and diagnostics. */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";

import type { DetectionResult, DoctorResult, IntegrationStatus } from "@birdybeep/agent-core";

import { detectCopilot } from "./detect";
import { isCurrentCopilotHooks } from "./install";
import { copilotHooksDir, copilotHooksPath, type CopilotPathOptions } from "./paths";

export const COPILOT_ADAPTER_VERSION = "0.0.0";

export interface CopilotStatusOptions extends CopilotPathOptions {
  detect?: () => Promise<DetectionResult>;
}

interface HookState {
  exists: boolean;
  parseable: boolean;
  current: boolean;
}

function inspectHooks(options: CopilotPathOptions): HookState {
  const path = copilotHooksPath(options);
  if (!existsSync(path)) return { exists: false, parseable: true, current: false };
  try {
    return {
      exists: true,
      parseable: true,
      current: isCurrentCopilotHooks(JSON.parse(readFileSync(path, "utf8"))),
    };
  } catch {
    return { exists: true, parseable: false, current: false };
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
