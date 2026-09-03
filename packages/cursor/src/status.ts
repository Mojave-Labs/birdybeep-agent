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
import { staleHookCommandPaths } from "@birdybeep/agent-core";

import { detectCursor } from "./detect";
import {
  backupPathFor,
  BIRDYBEEP_HOOK_EVENTS,
  installedBirdyBeepCommands,
  isBirdyBeepEntry,
} from "./install";
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
  /**
   * Absolute paths referenced by the installed BirdyBeep commands that no longer exist —
   * the CLI moved, or the Node it was installed under is gone (gcgp.9). Cursor would fail
   * these hooks with exit 127.
   */
  stalePaths: string[];
}

function inspectHooks(home: string): HookState {
  const path = cursorHooksPath(home);
  const total = BIRDYBEEP_HOOK_EVENTS.length;
  const empty = { present: 0, total, stalePaths: [] };
  if (!existsSync(path)) return { exists: false, parseable: true, ...empty };
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { exists: true, parseable: false, ...empty };
  }
  const hooks = asRecord(parsed["hooks"]);
  let present = 0;
  for (const event of BIRDYBEEP_HOOK_EVENTS) {
    const entries = hooks[event];
    if (Array.isArray(entries) && entries.some(isBirdyBeepEntry)) present += 1;
  }
  const stalePaths = [
    ...new Set(
      installedBirdyBeepCommands(parsed).flatMap((command) =>
        staleHookCommandPaths(command, existsSync),
      ),
    ),
  ];
  return { exists: true, parseable: true, present, total, stalePaths };
}

/** Smallest user-configured deadline on a BirdyBeep Cursor hook, if readable. */
export function configuredCursorHookTimeoutSeconds(home: string = homedir()): number | undefined {
  try {
    const parsed = asRecord(JSON.parse(readFileSync(cursorHooksPath(home), "utf8")));
    const hooks = asRecord(parsed["hooks"]);
    const timeouts: number[] = [];
    for (const entries of Object.values(hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const record = asRecord(entry);
        const timeout = record["timeout"];
        if (
          isBirdyBeepEntry(entry) &&
          typeof timeout === "number" &&
          Number.isFinite(timeout) &&
          timeout > 0
        ) {
          timeouts.push(timeout);
        }
      }
    }
    return timeouts.length > 0 ? Math.min(...timeouts) : undefined;
  } catch {
    return undefined;
  }
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
      // The remedy names the REAL recovery path: install refuses to write into a file it
      // cannot parse, and it left a one-time copy of the user's original at
      // `<hooks.json>.birdybeep-backup` — so point at that file when it actually exists
      // rather than at a backup the user may never have had.
      const backupPath = backupPathFor(path);
      checks.push({
        name: "hooks.json is valid JSON",
        ok: false,
        status: "error",
        detail: `${path} is not valid JSON.`,
        remedy: existsSync(backupPath)
          ? `Restore the BirdyBeep backup at ${backupPath} over ${path} (or delete the malformed file), then run \`birdybeep agent install cursor\`.`
          : `Fix the JSON in ${path} (or delete it), then run \`birdybeep agent install cursor\`.`,
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

      // gcgp.9: a stale absolute path is the failure that produces exit 127 with NO other
      // symptom — the hooks look installed and silently deliver nothing. Only meaningful once
      // something of ours is actually installed.
      if (hooks.present > 0) {
        checks.push(
          hooks.stalePaths.length === 0
            ? { name: "Hook command resolves", ok: true }
            : {
                name: "Hook command resolves",
                ok: false,
                status: "error",
                detail: `The installed hook command points at ${hooks.stalePaths.join(", ")}, which no longer exists. Cursor fails these hooks with exit 127.`,
                remedy:
                  "Run `birdybeep agent install cursor` to rewrite the hook command for the current CLI.",
              },
        );
      }
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
