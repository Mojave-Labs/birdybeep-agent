/**
 * The Claude Code AgentAdapter (§9.5) — highest-priority integration. All six
 * AgentAdapter methods are live: detect (CC-DETECT), install (CC-INSTALL), uninstall
 * (CC-UNINSTALL), normalizeEvent (CC-NORMALIZE), status + doctor (CC-STATUS-DOCTOR).
 * The real hook-fire E2E (CC-E2E) is a supervised gate.
 */
import type { AgentAdapter } from "@birdybeep/agent-core";

import { detectClaudeCode } from "./detect";
import { installClaudeCode } from "./install";
import { normalizeClaudeCodeEvent } from "./normalize";
import { claudeCodeDoctor, claudeCodeStatus } from "./status";
import { uninstallClaudeCode } from "./uninstall";

/** Stable BirdyBeep harness id for Claude Code (§9.5). */
export const CLAUDE_CODE_HARNESS_ID = "claude_code";

export const claudeCodeAdapter: AgentAdapter = {
  id: "claude_code",
  displayName: "Claude Code",
  detect: () => detectClaudeCode(),
  install: (options) => installClaudeCode(options ?? {}),
  uninstall: (options) => uninstallClaudeCode(options ?? {}),
  status: () => claudeCodeStatus(),
  doctor: () => claudeCodeDoctor(),
  normalizeEvent: (input) => normalizeClaudeCodeEvent(input),
};
