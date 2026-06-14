/**
 * @birdybeep/codex — the Codex adapter (one-time hook trust). Implements the
 * agent-core `AgentAdapter` contract for Codex's user-level notify + hook config (§9.6).
 */
export { CODEX_HARNESS_ID, codexAdapter } from "./adapter";
export { type CodexDetectOptions, detectCodex } from "./detect";
export {
  backupPathFor,
  BIRDYBEEP_HOOK_COMMAND,
  BIRDYBEEP_HOOK_EVENTS,
  BIRDYBEEP_NOTIFY,
  installCodex,
  isBirdyBeepHookEntry,
  mergeCodexConfig,
  TRUST_INSTRUCTIONS,
} from "./install";
export { CodexMappingError, normalizeCodexEvent } from "./normalize";
export { codexConfigDir, codexConfigFile, type CodexPathOptions } from "./paths";
export {
  CODEX_ADAPTER_VERSION,
  codexDoctor,
  codexStatus,
  type CodexStatusOptions,
  codexStatusReport,
  type StatusReport,
} from "./status";
export {
  clearCodexTrust,
  codexTrustMarkerIsStrict,
  codexTrustMarkerPath,
  type CodexTrustOptions,
  hasCodexEventBeenSeen,
  recordCodexEventSeen,
  runCodexHook,
} from "./trust";
