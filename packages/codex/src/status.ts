/**
 * Codex status() + doctor() (§8.8, §9.6). status() derives a §8.8 value from detection,
 * the state of `~/.codex/config.toml` (is the BirdyBeep notify managed + are all lifecycle
 * hook entries present?), and the trust marker (has a real event been seen?). Codex is
 * unique: writing config is NOT "installed" — hooks are trust-gated, so we report
 * `needs_trust` until a real trusted lifecycle hook flips the marker (CX-TRUST; a
 * turn-complete beep via the ungated notify program does not count). doctor() diagnoses
 * each failure mode with an actionable fix. Both are READ-ONLY: never mutate config.
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
import { parse } from "smol-toml";

import { detectCodex } from "./detect";
import {
  BIRDYBEEP_HOOK_COMMAND,
  BIRDYBEEP_HOOK_EVENTS,
  BIRDYBEEP_NOTIFY,
  isBirdyBeepHookEntry,
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
  notifyManaged: boolean;
  /** Count of BIRDYBEEP_HOOK_EVENTS carrying a well-formed BirdyBeep entry. */
  present: number;
  total: number;
}

function notifyIsManaged(value: unknown): boolean {
  return Array.isArray(value) && value.join(" ") === [...BIRDYBEEP_NOTIFY].join(" ");
}

function inspectConfig(home: string): ConfigState {
  const path = codexConfigFile({ home });
  const total = BIRDYBEEP_HOOK_EVENTS.length;
  if (!existsSync(path)) {
    return { exists: false, parseable: true, notifyManaged: false, present: 0, total };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(parse(readFileSync(path, "utf8")));
  } catch {
    return { exists: true, parseable: false, notifyManaged: false, present: 0, total };
  }
  const hooks = asRecord(parsed["hooks"]);
  let present = 0;
  for (const event of BIRDYBEEP_HOOK_EVENTS) {
    const entries = hooks[event];
    if (Array.isArray(entries) && entries.some(isBirdyBeepHookEntry)) present += 1;
  }
  return {
    exists: true,
    parseable: true,
    notifyManaged: notifyIsManaged(parsed["notify"]),
    present,
    total,
  };
}

function resolveDetect(opts: CodexStatusOptions): Promise<DetectionResult> {
  if (opts.detect) return opts.detect();
  return detectCodex(opts.home !== undefined ? { home: opts.home } : {});
}

/** Both notify and EVERY lifecycle hook are BirdyBeep-managed. */
function fullyConfigured(c: ConfigState): boolean {
  return c.notifyManaged && c.present === c.total;
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
  if (config.notifyManaged || config.present > 0) return "error"; // partial install → re-run
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
      checks.push({
        name: "config.toml is valid TOML",
        ok: false,
        status: "error",
        detail: `${path} is not valid TOML.`,
        remedy: "Fix or remove the malformed config.toml, then re-run install.",
      });
    } else {
      checks.push({ name: "config.toml is valid TOML", ok: true });

      // 3. BirdyBeep notify + hooks present, pointing at `birdybeep hook codex`?
      const configured = fullyConfigured(config);
      checks.push(
        configured
          ? { name: "BirdyBeep notify + hooks installed", ok: true }
          : {
              name: "BirdyBeep notify + hooks installed",
              ok: false,
              status: config.notifyManaged || config.present > 0 ? "error" : "unknown",
              detail:
                config.notifyManaged || config.present > 0
                  ? `Codex config is partially configured (notify ${config.notifyManaged ? "ok" : "missing"}, ${config.present}/${config.total} hooks). Expected command: \`${BIRDYBEEP_HOOK_COMMAND}\`.`
                  : "BirdyBeep is not installed in Codex.",
              remedy: "Run `birdybeep agent install codex` to (re)install the notify + hooks.",
            },
      );

      // 4. Trust granted (a trust-gated lifecycle hook has actually fired)?
      // NB: turn-complete beeps can already be arriving via the ungated `notify` program
      // while the hooks are still untrusted — so the detail must not say "no events yet".
      if (configured) {
        checks.push(
          hasCodexEventBeenSeen(opts)
            ? { name: "Codex hooks trusted", ok: true, status: "installed" }
            : {
                name: "Codex hooks trusted",
                ok: false,
                status: "needs_trust",
                detail:
                  "BirdyBeep hooks are installed but Codex has not fired a trusted lifecycle hook yet. " +
                  "Until they are trusted, Codex silently skips them — so approval beeps will NOT arrive " +
                  "(turn-complete beeps still work: they come from `notify`, which needs no trust).",
                remedy: "Open Codex and run /hooks to trust the BirdyBeep hooks.",
              },
        );
      }
    }

    // 5. config writable (a read-only file/dir blocks install/uninstall).
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
