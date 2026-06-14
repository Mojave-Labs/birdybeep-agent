/**
 * @birdybeep/claude-code — the Claude Code adapter (highest-priority integration).
 * Implements the agent-core `AgentAdapter` contract (detect/install/uninstall/
 * status/doctor/normalizeEvent) for Claude Code's user-level hook config (§9.5).
 */
export { CLAUDE_CODE_HARNESS_ID, claudeCodeAdapter } from "./adapter";
export { detectClaudeCode, type DetectOptions } from "./detect";
export {
  backupPathFor,
  BIRDYBEEP_HOOK_COMMAND,
  BIRDYBEEP_HOOK_EVENTS,
  installClaudeCode,
  isBirdyBeepEntry,
  mergeBirdyBeepHooks,
} from "./install";
export { ClaudeCodeMappingError, normalizeClaudeCodeEvent } from "./normalize";
export { claudeConfigDir, claudeSettingsPath } from "./paths";
export { removeBirdyBeepHooks, uninstallClaudeCode } from "./uninstall";
