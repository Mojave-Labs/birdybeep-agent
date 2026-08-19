/**
 * @birdybeep/codex — the Codex adapter (one-time hook trust). Implements the
 * agent-core `AgentAdapter` contract for Codex's user-level lifecycle hooks (§9.6).
 */
export { CODEX_HARNESS_ID, codexAdapter } from "./adapter";
export { type CodexDetectOptions, codexSurfaces, detectCodex } from "./detect";
export {
  backupPathFor,
  BIRDYBEEP_HOOK_COMMAND,
  BIRDYBEEP_HOOK_EVENTS,
  clearCodexMigration,
  codexMigrationMarkerPath,
  type CodexMigrationOptions,
  codexMigrationRecorded,
  codexTurnCompleteIsDark,
  installCodex,
  installedBirdyBeepCommands,
  isBirdyBeepHook,
  isBirdyBeepHookEntry,
  LEGACY_BIRDYBEEP_NOTIFY,
  mergeCodexConfig,
  type MergeResult,
  MIGRATION_WARNING,
  notifyIsLegacyBirdyBeep,
  recordCodexMigration,
  resolveCodexHookCommand,
  TRUST_INSTRUCTIONS,
} from "./install";
export {
  CODEX_HOOK_EVENTS,
  CODEX_NOTIFY_TYPES,
  CodexMappingError,
  codexSurfaceFromPayload,
  isCodexHookPayload,
  normalizeCodexEvent,
  sessionMetaFromRollout,
} from "./normalize";
export {
  chatgptDesktopCodexPath,
  codexConfigDir,
  codexConfigFile,
  type CodexDesktopOptions,
  type CodexPathOptions,
} from "./paths";
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
export { removeBirdyBeepConfig, uninstallCodex } from "./uninstall";
