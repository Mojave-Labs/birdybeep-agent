/**
 * @birdybeep/cursor — the Cursor adapter. Implements the agent-core `AgentAdapter` contract
 * (detect/install/uninstall/status/doctor/normalizeEvent) for Cursor's user-level hooks config
 * (`~/.cursor/hooks.json`, format `{ version: 1, hooks: { <eventName>: [ { command, timeout } ] } }`).
 * Cursor delivers each hook's event payload as JSON on stdin, so the managed command
 * `birdybeep hook cursor` reads stdin — matching the other stdin-based adapters.
 */
export { CURSOR_HARNESS_ID, cursorAdapter } from "./adapter";
export { detectCursor, type DetectOptions } from "./detect";
export { runCursorHook } from "./hook";
export {
  backupPathFor,
  BIRDYBEEP_HOOK_COMMAND,
  BIRDYBEEP_HOOK_EVENTS,
  CURSOR_HOOKS_VERSION,
  installCursor,
  isBirdyBeepEntry,
  mergeBirdyBeepHooks,
} from "./install";
export { CursorMappingError, normalizeCursorEvent } from "./normalize";
export { cursorConfigDir, cursorHooksPath } from "./paths";
export {
  CURSOR_ADAPTER_VERSION,
  cursorDoctor,
  cursorStatus,
  cursorStatusReport,
  type StatusOptions,
  type StatusReport,
} from "./status";
export { removeBirdyBeepHooks, uninstallCursor } from "./uninstall";
