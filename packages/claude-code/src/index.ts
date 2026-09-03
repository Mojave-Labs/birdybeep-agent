/**
 * @birdybeep/claude-code — the Claude Code adapter (highest-priority integration).
 * Implements the agent-core `AgentAdapter` contract (detect/install/uninstall/
 * status/doctor/normalizeEvent) for Claude Code's user-level hook config (§9.5).
 */
export { CLAUDE_CODE_HARNESS_ID, claudeCodeAdapter } from "./adapter";
export { claudeCodeSurfaces, detectClaudeCode, type DetectOptions } from "./detect";
export { runClaudeHook } from "./hook";
export {
  backupPathFor,
  BIRDYBEEP_HOOK_COMMAND,
  BIRDYBEEP_HOOK_EVENTS,
  installClaudeCode,
  installedBirdyBeepCommands,
  isBirdyBeepEntry,
  isBirdyBeepHook,
  mergeBirdyBeepHooks,
  resolveClaudeHookCommand,
} from "./install";
export {
  CLAUDE_CODE_HOOK_EVENTS,
  CLAUDE_CODE_NON_HOOK_EVENTS,
  ClaudeCodeMappingError,
  claudeCodeSurface,
  isClaudeCodeHookPayload,
  normalizeClaudeCodeEvent,
} from "./normalize";
export {
  claudeConfigDir,
  claudeDesktopEngineBinary,
  claudeDesktopEngineRoot,
  type ClaudeDesktopOptions,
  claudeSettingsPath,
} from "./paths";
export {
  CLAUDE_CODE_ADAPTER_VERSION,
  claudeCodeDoctor,
  claudeCodeStatus,
  claudeCodeStatusReport,
  configuredClaudeHookTimeoutSeconds,
  type StatusReport,
} from "./status";
export { removeBirdyBeepHooks, uninstallClaudeCode } from "./uninstall";
