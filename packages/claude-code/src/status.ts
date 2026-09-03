/**
 * Claude Code status() + doctor() (§8.8, §9.5). status() derives a §8.8 value from
 * detection + the state of `~/.claude/settings.json` (are all BirdyBeep hook entries
 * present + well-formed?). doctor() diagnoses the common failure modes and returns an
 * actionable fix for each. Claude Code reads settings live, so it never needs
 * `needs_restart`/`needs_trust` (those are OpenCode/Codex). No remote reporting here.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import {
  type DetectionResult,
  type DoctorResult,
  type IntegrationStatus,
  staleHookCommandPaths,
} from "@birdybeep/agent-core";

import { detectClaudeCode } from "./detect";
import {
  backupPathFor,
  BIRDYBEEP_HOOK_EVENTS,
  installedBirdyBeepCommands,
  isBirdyBeepEntry,
  isBirdyBeepHook,
} from "./install";
import { claudeConfigDir, claudeSettingsPath } from "./paths";

/** Adapter version surfaced in the status report / backend integration record. */
export const CLAUDE_CODE_ADAPTER_VERSION = "0.0.0";

export interface StatusOptions {
  home?: string;
  /** Injectable detection for tests (avoids shelling out to `claude --version`). */
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
   * the CLI moved, or the Node it was installed under is gone (gcgp.9). The harness fails
   * these hooks with exit 127 and nothing else looks wrong.
   */
  stalePaths: string[];
}

function inspectHooks(home: string): HookState {
  const path = claudeSettingsPath(home);
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

/** Smallest user-configured deadline on a BirdyBeep Claude hook, if readable. */
export function configuredClaudeHookTimeoutSeconds(home: string = homedir()): number | undefined {
  try {
    const parsed = asRecord(JSON.parse(readFileSync(claudeSettingsPath(home), "utf8")));
    const hooks = asRecord(parsed["hooks"]);
    const timeouts: number[] = [];
    for (const entries of Object.values(hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const innerHooks = asRecord(entry)["hooks"];
        if (!Array.isArray(innerHooks)) continue;
        for (const hook of innerHooks) {
          const record = asRecord(hook);
          const timeout = record["timeout"];
          if (
            isBirdyBeepHook(hook) &&
            typeof timeout === "number" &&
            Number.isFinite(timeout) &&
            timeout > 0
          ) {
            timeouts.push(timeout);
          }
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
  return detectClaudeCode(opts.home !== undefined ? { home: opts.home } : {});
}

/** Current §8.8 integration status for Claude Code. */
export async function claudeCodeStatus(opts: StatusOptions = {}): Promise<IntegrationStatus> {
  const home = opts.home ?? homedir();
  const detection = await resolveDetect(opts);
  if (!detection.detected) return "not_detected";
  const hooks = inspectHooks(home);
  if (!hooks.parseable) return "error"; // settings.json is corrupt
  if (hooks.present === hooks.total) return "installed";
  if (hooks.present > 0) return "error"; // partially installed → re-run install
  return "unknown"; // Claude Code present, BirdyBeep not installed
}

export interface StatusReport {
  status: IntegrationStatus;
  harnessVersion?: string;
  adapterVersion: string;
}

/** status() + the versions the backend integration record / Integrations screen show. */
export async function claudeCodeStatusReport(opts: StatusOptions = {}): Promise<StatusReport> {
  const detection = await resolveDetect(opts);
  const status = await claudeCodeStatus({ ...opts, detect: () => Promise.resolve(detection) });
  const report: StatusReport = { status, adapterVersion: CLAUDE_CODE_ADAPTER_VERSION };
  if (detection.version !== undefined) report.harnessVersion = detection.version;
  return report;
}

/** Diagnose Claude Code integration health with actionable fixes. */
export async function claudeCodeDoctor(opts: StatusOptions = {}): Promise<DoctorResult> {
  const home = opts.home ?? homedir();
  const detection = await resolveDetect(opts);
  const checks: DoctorResult["checks"] = [];

  checks.push(
    detection.detected
      ? { name: "Claude Code installed", ok: true, status: "installed" }
      : {
          name: "Claude Code installed",
          ok: false,
          status: "not_detected",
          detail: "Claude Code was not found on this machine.",
          remedy: "Install Claude Code, then re-run `birdybeep agent install claude`.",
        },
  );

  if (detection.detected) {
    const path = claudeSettingsPath(home);
    const hooks = inspectHooks(home);

    if (!hooks.parseable) {
      // birdybeep-agent-8kt (house style from tu1): the remedy names the REAL recovery path —
      // install refuses to write into a file it cannot parse, and it left a one-time copy of the
      // user's original at `<settings.json>.birdybeep-backup` — so point at that file when it
      // actually exists rather than at a backup the user may never have had.
      const backupPath = backupPathFor(path);
      checks.push({
        name: "settings.json is valid JSON",
        ok: false,
        status: "error",
        detail: `${path} is not valid JSON.`,
        remedy: existsSync(backupPath)
          ? `Restore the BirdyBeep backup at ${backupPath} over ${path} (or delete the malformed file), then run \`birdybeep agent install claude\`.`
          : `Fix the JSON in ${path} (or delete it), then run \`birdybeep agent install claude\`.`,
      });
    } else {
      checks.push({ name: "settings.json is valid JSON", ok: true });
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
              remedy: "Run `birdybeep agent install claude` to (re)install the hooks.",
            },
      );

      // gcgp.9: a stale absolute path is the failure that produces exit 127 with NO other
      // symptom — the hooks still read as fully installed and silently deliver nothing.
      if (hooks.present > 0) {
        checks.push(
          hooks.stalePaths.length === 0
            ? { name: "Hook command resolves", ok: true }
            : {
                name: "Hook command resolves",
                ok: false,
                status: "error",
                detail: `The installed hook command points at ${hooks.stalePaths.join(", ")}, which no longer exists. The harness fails these hooks with exit 127.`,
                remedy:
                  "Run `birdybeep agent install claude` to rewrite the hook command for the current CLI.",
              },
        );
      }
    }

    // Writability: a read-only settings file (or config dir) blocks install/uninstall.
    const target = existsSync(path) ? path : claudeConfigDir(home);
    let writable = true;
    try {
      if (existsSync(target)) accessSync(target, constants.W_OK);
    } catch {
      writable = false;
    }
    checks.push(
      writable
        ? { name: "settings.json writable", ok: true }
        : {
            name: "settings.json writable",
            ok: false,
            status: "error",
            detail: `${target} is not writable.`,
            remedy: "Fix file permissions so BirdyBeep can update Claude Code settings.",
          },
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}
