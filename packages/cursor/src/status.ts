/**
 * Cursor status() + doctor() (§8.8, §9.x). status() derives a §8.8 value from detection +
 * the state of `~/.cursor/hooks.json` (are all BirdyBeep hook entries present + well-formed?).
 * Cursor has NO trust gate (unlike Codex) and reads hooks.json live (unlike OpenCode's restart),
 * so it reports `installed` immediately when the entries are present. doctor() diagnoses the
 * common failure modes and returns an actionable fix for each. No remote reporting here.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import type { DetectionResult, DoctorResult, IntegrationStatus } from "@birdybeep/agent-core";

import { detectCursor } from "./detect";
import { BIRDYBEEP_HOOK_EVENTS, isBirdyBeepEntry } from "./install";
import { cursorConfigDir, cursorHooksPath } from "./paths";

/** Adapter version surfaced in the status report / backend integration record. */
export const CURSOR_ADAPTER_VERSION = "0.0.0";

export interface StatusOptions {
  home?: string;
  /** Injectable detection for tests (avoids shelling out to `cursor-agent --version`). */
  detect?: () => Promise<DetectionResult>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface HookState {
  exists: boolean;
  parseable: boolean;
  /** Count of BIRDYBEEP_HOOK_EVENTS that carry a well-formed BirdyBeep entry. */
  present: number;
  total: number;
}

function inspectHooks(home: string): HookState {
  const path = cursorHooksPath(home);
  const total = BIRDYBEEP_HOOK_EVENTS.length;
  if (!existsSync(path)) return { exists: false, parseable: true, present: 0, total };
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { exists: true, parseable: false, present: 0, total };
  }
  const hooks = asRecord(parsed["hooks"]);
  let present = 0;
  for (const event of BIRDYBEEP_HOOK_EVENTS) {
    const entries = hooks[event];
    if (Array.isArray(entries) && entries.some(isBirdyBeepEntry)) present += 1;
  }
  return { exists: true, parseable: true, present, total };
}

function resolveDetect(opts: StatusOptions): Promise<DetectionResult> {
  if (opts.detect) return opts.detect();
  return detectCursor(opts.home !== undefined ? { home: opts.home } : {});
}

/** Current §8.8 integration status for Cursor. */
export async function cursorStatus(opts: StatusOptions = {}): Promise<IntegrationStatus> {
  const home = opts.home ?? homedir();
  const detection = await resolveDetect(opts);
  if (!detection.detected) return "not_detected";
  const hooks = inspectHooks(home);
  if (!hooks.parseable) return "error"; // hooks.json is corrupt
  if (hooks.present === hooks.total) return "installed"; // no trust/restart gate → live immediately
  if (hooks.present > 0) return "error"; // partially installed → re-run install
  return "unknown"; // Cursor present, BirdyBeep not installed
}

export interface StatusReport {
  status: IntegrationStatus;
  harnessVersion?: string;
  adapterVersion: string;
}

/** status() + the versions the backend integration record / Integrations screen show. */
export async function cursorStatusReport(opts: StatusOptions = {}): Promise<StatusReport> {
  const detection = await resolveDetect(opts);
  const status = await cursorStatus({ ...opts, detect: () => Promise.resolve(detection) });
  const report: StatusReport = { status, adapterVersion: CURSOR_ADAPTER_VERSION };
  if (detection.version !== undefined) report.harnessVersion = detection.version;
  return report;
}

/** Diagnose Cursor integration health with actionable fixes. */
export async function cursorDoctor(opts: StatusOptions = {}): Promise<DoctorResult> {
  const home = opts.home ?? homedir();
  const detection = await resolveDetect(opts);
  const checks: DoctorResult["checks"] = [];

  checks.push(
    detection.detected
      ? { name: "Cursor installed", ok: true, status: "installed" }
      : {
          name: "Cursor installed",
          ok: false,
          status: "not_detected",
          detail: "Cursor was not found on this machine.",
          remedy: "Install Cursor, then re-run `birdybeep agent install cursor`.",
        },
  );

  if (detection.detected) {
    const path = cursorHooksPath(home);
    const hooks = inspectHooks(home);

    if (!hooks.parseable) {
      checks.push({
        name: "hooks.json is valid JSON",
        ok: false,
        status: "error",
        detail: `${path} is not valid JSON.`,
        remedy: "Fix or remove the malformed hooks.json, then re-run install.",
      });
    } else {
      checks.push({ name: "hooks.json is valid JSON", ok: true });
      checks.push(
        hooks.present === hooks.total
          ? { name: "BirdyBeep hooks installed", ok: true, status: "installed" }
          : {
              name: "BirdyBeep hooks installed",
              ok: false,
              status: hooks.present > 0 ? "error" : "unknown",
              detail:
                hooks.present > 0
                  ? `Only ${hooks.present}/${hooks.total} BirdyBeep hooks are installed (partial).`
                  : "BirdyBeep hooks are not installed.",
              remedy: "Run `birdybeep agent install cursor` to (re)install the hooks.",
            },
      );
    }

    // Writability: a read-only hooks file (or config dir) blocks install/uninstall.
    const target = existsSync(path) ? path : cursorConfigDir(home);
    let writable = true;
    try {
      if (existsSync(target)) accessSync(target, constants.W_OK);
    } catch {
      writable = false;
    }
    checks.push(
      writable
        ? { name: "hooks.json writable", ok: true }
        : {
            name: "hooks.json writable",
            ok: false,
            status: "error",
            detail: `${target} is not writable.`,
            remedy: "Fix file permissions so BirdyBeep can update Cursor hooks.",
          },
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}
