/**
 * The OpenCode AgentAdapter (§9.7) — a plugin-based integration. OpenCode loads plugins
 * only at startup, so install surfaces `needs_restart` until the next launch. Built up
 * across the a-opencode tickets: detect() is live (OC-DETECT); plugin/install/uninstall/
 * status/doctor/normalizeEvent land in their own tickets and replace the stubs below.
 */
import type { AgentAdapter } from "@birdybeep/agent-core";

import { detectOpenCode } from "./detect";
import { installOpenCode } from "./install";
import { normalizeOpenCodeEvent } from "./normalize";
import { opencodeDoctor, opencodeStatus } from "./status";
import { uninstallOpenCode } from "./uninstall";

/** Stable BirdyBeep harness id for OpenCode (§9.7). */
export const OPENCODE_HARNESS_ID = "opencode";

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  displayName: "OpenCode",
  detect: () => detectOpenCode(),
  install: (options) => installOpenCode(options ?? {}),
  uninstall: (options) => uninstallOpenCode(options ?? {}),
  status: () => opencodeStatus(),
  doctor: () => opencodeDoctor(),
  normalizeEvent: (input) => normalizeOpenCodeEvent(input),
};
