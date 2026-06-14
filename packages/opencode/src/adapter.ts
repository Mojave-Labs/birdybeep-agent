/**
 * The OpenCode AgentAdapter (§9.7) — a plugin-based integration. OpenCode loads plugins
 * only at startup, so install surfaces `needs_restart` until the next launch. Built up
 * across the a-opencode tickets: detect() is live (OC-DETECT); plugin/install/uninstall/
 * status/doctor/normalizeEvent land in their own tickets and replace the stubs below.
 */
import type { AgentAdapter } from "@birdybeep/agent-core";

import { detectOpenCode } from "./detect";

/** Stable BirdyBeep harness id for OpenCode (§9.7). */
export const OPENCODE_HARNESS_ID = "opencode";

function notImplemented(ticket: string): Promise<never> {
  return Promise.reject(new Error(`OpenCode adapter: not implemented yet (${ticket})`));
}

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  displayName: "OpenCode",
  detect: () => detectOpenCode(),
  install: () => notImplemented("OC-INSTALL"),
  uninstall: () => notImplemented("OC-UNINSTALL"),
  status: () => notImplemented("OC-STATUS-DOCTOR"),
  doctor: () => notImplemented("OC-STATUS-DOCTOR"),
  normalizeEvent: () => notImplemented("OC-NORMALIZE"),
};
