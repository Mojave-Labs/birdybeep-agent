export { COPILOT_HARNESS_ID, copilotAdapter } from "./adapter";
export { detectCopilot, type DetectCopilotOptions } from "./detect";
export { runCopilotHook } from "./hook";
export {
  COPILOT_HOOK_EVENTS,
  COPILOT_HOOK_TIMEOUT_SECONDS,
  COPILOT_HOOKS_VERSION,
  copilotBackupPath,
  copilotHookCommand,
  type CopilotHookCommands,
  copilotHookCommands,
  type CopilotHookEventName,
  type CopilotInstallOptions,
  generatedCopilotHooks,
  generatedCopilotHooksText,
  installCopilot,
  installedBirdyBeepCommands,
  isCopilotHookEventName,
  isCurrentCopilotHooks,
  resolveCopilotLauncher,
} from "./install";
export { CopilotMappingError, normalizeCopilotEvent } from "./normalize";
export {
  BIRDYBEEP_HOOKS_FILE,
  copilotConfigDir,
  copilotHooksDir,
  copilotHooksPath,
  type CopilotPathOptions,
} from "./paths";
export {
  COPILOT_ADAPTER_VERSION,
  copilotDoctor,
  copilotStatus,
  type CopilotStatusOptions,
  type CopilotStatusReport,
  copilotStatusReport,
} from "./status";
export { type CopilotUninstallOptions, uninstallCopilot } from "./uninstall";
