/**
 * The `AgentAdapter` interface (§9.1): the one uniform contract the Claude Code,
 * Codex, and OpenCode adapters all implement, so the CLI can detect/install/
 * uninstall/check/doctor/normalize any harness without special-casing. New
 * harnesses plug in by implementing this — nothing in the CLI changes.
 *
 * Contract every adapter MUST honor (§7.3), enforced by the shared E2E harness:
 *   - install is IDEMPOTENT (a second install is a no-op);
 *   - existing config is BACKED UP before modification;
 *   - only BirdyBeep-MANAGED entries are added (existing config preserved);
 *   - tokens are NEVER written into harness config or repo files;
 *   - install/uninstall report changed files + any required user actions;
 *   - uninstall removes exactly the managed entries (restores the original).
 */
import type { BirdyBeepAgentEvent } from "./event";
import type { HarnessId } from "./primitives";

/** Integration status values (§8.8). */
export const INTEGRATION_STATUSES = [
  "installed",
  "not_detected",
  "needs_restart",
  "needs_trust",
  "error",
  "revoked",
  "unknown",
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/** Result of probing whether a harness is present on the machine. */
export interface DetectionResult {
  detected: boolean;
  version?: string;
  /** Path to the harness config the adapter would manage, if found. */
  configPath?: string;
  detail?: string;
}

export interface InstallOptions {
  /** Compute + report changes without writing anything. */
  dryRun?: boolean;
}

export interface InstallResult {
  /** False when the install was a no-op (already installed / idempotent re-run). */
  changed: boolean;
  /** Config files created or modified by this install. */
  changedFiles: string[];
  /** Backups written before modifying pre-existing config. */
  backupFiles: string[];
  /** Actions the user must still take (e.g. trust Codex hooks, restart OpenCode). */
  requiredActions: string[];
  /** Resulting integration status (e.g. installed / needs_trust / needs_restart). */
  status: IntegrationStatus;
}

export interface UninstallOptions {
  dryRun?: boolean;
}

export interface UninstallResult {
  changed: boolean;
  /** Files removed (created by BirdyBeep). */
  removedFiles: string[];
  /** Files restored from backup to their pre-install contents. */
  restoredFiles: string[];
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  status?: IntegrationStatus;
  detail?: string;
  /** Suggested fix when `ok` is false. */
  remedy?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

/** The contract implemented by every harness adapter (§9.1). */
export interface AgentAdapter {
  /** Stable harness id (also the event `harness` value). */
  readonly id: HarnessId;
  /** Human-facing harness name, e.g. "Claude Code". */
  readonly displayName: string;

  /** Is this harness installed/usable on the machine? */
  detect(): Promise<DetectionResult>;
  /** Idempotently install BirdyBeep into the harness config (backs up first). */
  install(options?: InstallOptions): Promise<InstallResult>;
  /** Remove BirdyBeep's managed entries, restoring the original config. */
  uninstall(options?: UninstallOptions): Promise<UninstallResult>;
  /** Current integration status (§8.8). */
  status(): Promise<IntegrationStatus>;
  /** Diagnose integration health and suggest remedies. */
  doctor(): Promise<DoctorResult>;
  /** Map a raw harness payload to a redacted, validated canonical event. */
  normalizeEvent(input: unknown): Promise<BirdyBeepAgentEvent>;
}
