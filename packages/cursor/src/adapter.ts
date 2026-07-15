/**
 * The Cursor AgentAdapter (§9.x). All six AgentAdapter methods are live: detect (CUR-DETECT),
 * install (CUR-INSTALL), uninstall (CUR-UNINSTALL), normalizeEvent (CUR-NORMALIZE), status +
 * doctor (CUR-STATUS-DOCTOR). Cursor reads `~/.cursor/hooks.json` live and has no trust gate,
 * so it reports `installed` as soon as the managed entries are written.
 */
import type { AgentAdapter } from "@birdybeep/agent-core";

import { detectCursor } from "./detect";
import { installCursor } from "./install";
import { normalizeCursorEvent } from "./normalize";
import { cursorDoctor, cursorStatus } from "./status";
import { uninstallCursor } from "./uninstall";

/** Stable BirdyBeep harness id for Cursor (§9.x). */
export const CURSOR_HARNESS_ID = "cursor";

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor",
  detect: () => detectCursor(),
  install: (options) => installCursor(options ?? {}),
  uninstall: (options) => uninstallCursor(options ?? {}),
  status: () => cursorStatus(),
  doctor: () => cursorDoctor(),
  normalizeEvent: (input) => normalizeCursorEvent(input),
};
