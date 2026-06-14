/**
 * @birdybeep/opencode — the OpenCode adapter (plugin). Implements the agent-core
 * `AgentAdapter` contract for OpenCode's user-level plugin + config (§9.7). OpenCode
 * loads plugins only at startup, so install surfaces `needs_restart` until the next launch.
 */
export { OPENCODE_HARNESS_ID, opencodeAdapter } from "./adapter";
export { detectOpenCode, type OpenCodeDetectOptions } from "./detect";
export {
  backupPathFor,
  BIRDYBEEP_PLUGIN_REF,
  installOpenCode,
  isBirdyBeepPluginConfigured,
  mergeOpenCodeConfig,
  RESTART_INSTRUCTIONS,
} from "./install";
export { normalizeOpenCodeEvent, OpenCodeMappingError } from "./normalize";
export {
  opencodeConfigDir,
  opencodeConfigFile,
  type OpenCodePathOptions,
  opencodePluginDir,
} from "./paths";
export {
  type BirdyBeepHooks,
  BirdyBeepPlugin,
  type BirdyBeepPluginDeps,
  createBirdyBeepPlugin,
  FORWARDED_BUS_EVENTS,
  type OpenCodeEventEnvelope,
  type OpenCodePluginInput,
} from "./plugin";
export {
  clearOpenCodeRestart,
  hasOpenCodeEventBeenSeen,
  opencodeRestartMarkerIsStrict,
  opencodeRestartMarkerPath,
  type OpenCodeRestartOptions,
  recordOpenCodeEventSeen,
  runOpenCodeHook,
} from "./restart";
export {
  OPENCODE_ADAPTER_VERSION,
  opencodeDoctor,
  opencodeStatus,
  type OpenCodeStatusOptions,
  opencodeStatusReport,
  type StatusReport,
} from "./status";
export { removeBirdyBeepPlugin, uninstallOpenCode } from "./uninstall";
