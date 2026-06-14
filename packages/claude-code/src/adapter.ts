/**
 * The Claude Code AgentAdapter (§9.5) — highest-priority integration. Built up
 * across the a-claude tickets: detect() is live (CC-DETECT); install/uninstall/
 * status/doctor/normalizeEvent land in their own tickets and replace the stubs
 * below. The real hook-fire E2E (CC-E2E) is a supervised gate.
 */
import type { AgentAdapter, DoctorResult, IntegrationStatus } from "@birdybeep/agent-core";

import { detectClaudeCode } from "./detect";
import { installClaudeCode } from "./install";
import { normalizeClaudeCodeEvent } from "./normalize";
import { uninstallClaudeCode } from "./uninstall";

/** Stable BirdyBeep harness id for Claude Code (§9.5). */
export const CLAUDE_CODE_HARNESS_ID = "claude_code";

function notImplemented(ticket: string): Promise<never> {
  return Promise.reject(new Error(`Claude Code adapter: not implemented yet (${ticket})`));
}

export const claudeCodeAdapter: AgentAdapter = {
  id: "claude_code",
  displayName: "Claude Code",
  detect: () => detectClaudeCode(),
  install: (options) => installClaudeCode(options ?? {}),
  uninstall: (options) => uninstallClaudeCode(options ?? {}),
  status: (): Promise<IntegrationStatus> => notImplemented("CC-STATUS-DOCTOR"),
  doctor: (): Promise<DoctorResult> => notImplemented("CC-STATUS-DOCTOR"),
  normalizeEvent: (input) => normalizeClaudeCodeEvent(input),
};
