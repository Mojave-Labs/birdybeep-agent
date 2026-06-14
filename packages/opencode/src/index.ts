/**
 * @birdybeep/opencode — the OpenCode adapter (plugin). Implements the agent-core
 * `AgentAdapter` contract for OpenCode's user-level plugin + config (§9.7). OpenCode
 * loads plugins only at startup, so install surfaces `needs_restart` until the next launch.
 */
export { OPENCODE_HARNESS_ID, opencodeAdapter } from "./adapter";
export { detectOpenCode, type OpenCodeDetectOptions } from "./detect";
export { normalizeOpenCodeEvent, OpenCodeMappingError } from "./normalize";
export {
  opencodeConfigDir,
  opencodeConfigFile,
  type OpenCodePathOptions,
  opencodePluginDir,
} from "./paths";
export {
  type BirdyBeepHooks,
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
