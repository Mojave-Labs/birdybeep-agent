/**
 * Codex status() + doctor() (§8.8, §9.6). status() derives a §8.8 value from detection,
 * the state of `~/.codex/config.toml` (are all BirdyBeep lifecycle hook entries present?),
 * and the trust marker (has a real event been seen?). Codex is unique: writing config is
 * NOT "installed" — hooks are trust-gated, so we report `needs_trust` until a real trusted
 * lifecycle hook flips the marker (CX-TRUST). doctor() diagnoses each failure mode with an
 * actionable fix; every remedy it prints must be safe to run, which is why it can point at
 * `agent install codex` now that install never writes the shared `notify` slot
 * (birdybeep-agent-gcgp.2). Both are READ-ONLY: never mutate config.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import {
  type DetectionResult,
  type DoctorResult,
  getToken,
  type IntegrationStatus,
  staleHookCommandPaths,
  type TokenStoreOptions,
} from "@birdybeep/agent-core";
import { parse } from "smol-toml";

import { detectCodex } from "./detect";
import {
  backupPathFor,
  BIRDYBEEP_HOOK_COMMAND,
  BIRDYBEEP_HOOK_EVENTS,
  codexTurnCompleteIsDark,
  installedBirdyBeepCommands,
  isBirdyBeepHook,
  isBirdyBeepHookEntry,
  MIGRATION_WARNING,
  notifyIsLegacyBirdyBeep,
} from "./install";
import { codexConfigDir, codexConfigFile } from "./paths";
import { type CodexTrustOptions, hasCodexEventBeenSeen } from "./trust";

/** Adapter version surfaced in the status report / backend integration record. */
export const CODEX_ADAPTER_VERSION = "0.0.0";

export interface CodexStatusOptions extends CodexTrustOptions {
  home?: string;
  /** Injectable detection for tests (avoids shelling out to `codex --version`). */
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
  /** An older BirdyBeep's `notify` argv is still squatting the single notify slot. */
  legacyNotify: boolean;
  /** Count of BIRDYBEEP_HOOK_EVENTS carrying a well-formed BirdyBeep entry. */
  present: number;
  total: number;
  /**
   * Absolute paths referenced by the installed BirdyBeep commands that no longer exist — the CLI
   * moved, or the Node it was installed under is gone (gcgp.9). Codex fails these hooks with
   * exit 127 and nothing else looks wrong.
   */
  stalePaths: string[];
}

function inspectConfig(home: string): ConfigState {
  const path = codexConfigFile({ home });
  const total = BIRDYBEEP_HOOK_EVENTS.length;
  const empty = { legacyNotify: false, present: 0, total, stalePaths: [] };
  if (!existsSync(path)) return { exists: false, parseable: true, ...empty };
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(parse(readFileSync(path, "utf8")));
  } catch {
    return { exists: true, parseable: false, ...empty };
  }
  const hooks = asRecord(parsed["hooks"]);
  let present = 0;
  for (const event of BIRDYBEEP_HOOK_EVENTS) {
    const entries = hooks[event];
    if (Array.isArray(entries) && entries.some(isBirdyBeepHookEntry)) present += 1;
  }
  const stalePaths = [
    ...new Set(
      installedBirdyBeepCommands(parsed).flatMap((command) =>
        staleHookCommandPaths(command, existsSync),
      ),
    ),
  ];
  return {
    exists: true,
    parseable: true,
    legacyNotify: notifyIsLegacyBirdyBeep(parsed["notify"]),
    present,
    total,
    stalePaths,
  };
}

/** Smallest user-configured deadline on a BirdyBeep Codex lifecycle hook, if readable. */
export function configuredCodexHookTimeoutSeconds(home: string = homedir()): number | undefined {
  try {
    const parsed = asRecord(parse(readFileSync(codexConfigFile({ home }), "utf8")));
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

function resolveDetect(opts: CodexStatusOptions): Promise<DetectionResult> {
  if (opts.detect) return opts.detect();
  return detectCodex(opts.home !== undefined ? { home: opts.home } : {});
}

/** EVERY lifecycle hook BirdyBeep registers is present (`notify` is not ours to manage). */
function fullyConfigured(c: ConfigState): boolean {
  return c.present === c.total;
}

/** Current §8.8 integration status for Codex. */
export async function codexStatus(opts: CodexStatusOptions = {}): Promise<IntegrationStatus> {
  const home = opts.home ?? homedir();
  const detection = await resolveDetect(opts);
  if (!detection.detected) return "not_detected";
  const config = inspectConfig(home);
  if (config.exists && !config.parseable) return "error"; // config.toml is malformed
  if (fullyConfigured(config)) {
    // Trust-gated: installed only once a real event proves the hooks were trusted.
    return hasCodexEventBeenSeen(opts) ? "installed" : "needs_trust";
  }
  if (config.legacyNotify || config.present > 0) return "error"; // partial install → re-run
  return "unknown"; // Codex present, BirdyBeep not installed
}

export interface StatusReport {
  status: IntegrationStatus;
  harnessVersion?: string;
  adapterVersion: string;
}

/** status() + the versions the backend integration record / Integrations screen show. */
export async function codexStatusReport(opts: CodexStatusOptions = {}): Promise<StatusReport> {
  const detection = await resolveDetect(opts);
  const status = await codexStatus({ ...opts, detect: () => Promise.resolve(detection) });
  const report: StatusReport = { status, adapterVersion: CODEX_ADAPTER_VERSION };
  if (detection.version !== undefined) report.harnessVersion = detection.version;
  return report;
}

/** Diagnose Codex integration health with actionable fixes. */
export async function codexDoctor(opts: CodexStatusOptions = {}): Promise<DoctorResult> {
  const home = opts.home ?? homedir();
  const detection = await resolveDetect(opts);
  const checks: DoctorResult["checks"] = [];

  // 1. Codex present?
  checks.push(
    detection.detected
      ? { name: "Codex installed", ok: true, status: "installed" }
      : {
          name: "Codex installed",
          ok: false,
          status: "not_detected",
          detail: "Codex was not found on this machine.",
          remedy: "Install Codex, then re-run `birdybeep agent install codex`.",
        },
  );

  if (detection.detected) {
    const path = codexConfigFile({ home });
    const config = inspectConfig(home);

    // 2. config.toml valid TOML?
    if (config.exists && !config.parseable) {
      // birdybeep-agent-8kt (house style from tu1): the remedy names the REAL recovery path —
      // install refuses to write into a file it cannot parse, and it left a one-time copy of the
      // user's original at `<config.toml>.birdybeep-backup` — so point at that file when it
      // actually exists rather than at a backup the user may never have had.
      const backupPath = backupPathFor(path);
      checks.push({
        name: "config.toml is valid TOML",
        ok: false,
        status: "error",
        detail: `${path} is not valid TOML.`,
        remedy: existsSync(backupPath)
          ? `Restore the BirdyBeep backup at ${backupPath} over ${path} (or delete the malformed file), then run \`birdybeep agent install codex\`.`
          : `Fix the TOML in ${path} (or delete it), then run \`birdybeep agent install codex\`.`,
      });
    } else {
      checks.push({ name: "config.toml is valid TOML", ok: true });

      // 3. BirdyBeep hooks present, pointing at `birdybeep hook codex`?
      // The remedy is safe to follow: install only APPENDS to the `[[hooks.X]]` arrays and
      // never writes the single-valued `notify` slot (birdybeep-agent-gcgp.2).
      const configured = fullyConfigured(config);
      checks.push(
        configured
          ? { name: "BirdyBeep hooks installed", ok: true }
          : {
              name: "BirdyBeep hooks installed",
              ok: false,
              status: config.legacyNotify || config.present > 0 ? "error" : "unknown",
              detail:
                config.legacyNotify || config.present > 0
                  ? `Codex config is partially configured (${config.present}/${config.total} hooks). Expected command: \`${BIRDYBEEP_HOOK_COMMAND}\`.`
                  : "BirdyBeep is not installed in Codex.",
              remedy:
                "Run `birdybeep agent install codex` to (re)install the hooks. It adds only BirdyBeep entries and leaves any other tool's Codex config alone.",
            },
      );

      // 3b. gcgp.9 parity: a stale absolute path is the failure that produces exit 127 with NO
      // other symptom — the hooks still read as fully installed and silently deliver nothing.
      if (config.present > 0) {
        checks.push(
          config.stalePaths.length === 0
            ? { name: "Hook command resolves", ok: true }
            : {
                name: "Hook command resolves",
                ok: false,
                status: "error",
                detail: `The installed hook command points at ${config.stalePaths.join(", ")}, which no longer exists. Codex fails these hooks with exit 127.`,
                remedy:
                  "Run `birdybeep agent install codex` to rewrite the hook command for the current CLI.",
              },
        );
      }

      // 4. Leftover BirdyBeep `notify` from an older version squatting the single slot.
      if (config.legacyNotify) {
        checks.push({
          name: "Codex notify slot is not held by BirdyBeep",
          ok: false,
          status: "error",
          detail:
            "An older BirdyBeep set Codex's single-valued `notify` program. That slot belongs " +
            "to whichever tool writes it last, and turn-complete now arrives via the Stop hook.",
          remedy: "Run `birdybeep agent install codex` to remove the leftover `notify` entry.",
        });
      }

      // 5. Trust granted (a trust-gated lifecycle hook has actually fired)?
      if (configured) {
        // gcgp.15: an UPGRADE that rewrote the hook entries is not the same situation as a first
        // install, and saying "has not fired a trusted hook yet" to someone whose Codex beeps
        // worked yesterday reads as a fresh setup rather than a regression. Codex trusts hooks by
        // CONTENT, so rewritten entries go untrusted and are skipped in silence. The predicate is
        // derived (migration recorded, trust marker gone) and self-clears the moment a genuinely
        // trusted hook fires — no bookkeeping here.
        const dark = codexTurnCompleteIsDark(opts);
        checks.push(
          hasCodexEventBeenSeen(opts)
            ? { name: "Codex hooks trusted", ok: true, status: "installed" }
            : {
                name: "Codex hooks trusted",
                ok: false,
                status: "needs_trust",
                detail: dark
                  ? MIGRATION_WARNING.join(" ")
                  : "BirdyBeep hooks are installed but Codex has not fired a trusted lifecycle hook yet. " +
                    "Until they are trusted, Codex silently skips them, so no beeps will arrive.",
                remedy: "Open Codex and run /hooks to trust the BirdyBeep hooks.",
              },
        );
      }
    }

    // 6. config writable (a read-only file/dir blocks install/uninstall).
    const target = existsSync(path) ? path : codexConfigDir({ home });
    let writable = true;
    try {
      if (existsSync(target)) accessSync(target, constants.W_OK);
    } catch {
      writable = false;
    }
    checks.push(
      writable
        ? { name: "config.toml writable", ok: true }
        : {
            name: "config.toml writable",
            ok: false,
            status: "error",
            detail: `${target} is not writable.`,
            remedy: "Fix file permissions so BirdyBeep can update Codex config.",
          },
    );
  }

  // 7. Machine token resolvable?
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
