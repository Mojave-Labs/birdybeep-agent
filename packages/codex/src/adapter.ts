/**
 * The Codex AgentAdapter (§9.6) — launch integration with a one-time hook-trust
 * caveat (surfaced as `needs_trust` until a trusted lifecycle hook fires). Built up across
 * the a-codex tickets: detect() is live (CX-DETECT); install/uninstall/status/doctor/
 * normalizeEvent land in their own tickets and replace the stubs below.
 */
import type { AgentAdapter } from "@birdybeep/agent-core";

import { detectCodex } from "./detect";
import { installCodex } from "./install";
import { normalizeCodexEvent } from "./normalize";
import { codexDoctor, codexStatus } from "./status";
import { uninstallCodex } from "./uninstall";

/** Stable BirdyBeep harness id for Codex (§9.6). */
export const CODEX_HARNESS_ID = "codex";

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  detect: () => detectCodex(),
  install: (options) => installCodex(options ?? {}),
  uninstall: (options) => uninstallCodex(options ?? {}),
  status: () => codexStatus(),
  doctor: () => codexDoctor(),
  normalizeEvent: (input) => normalizeCodexEvent(input),
};
