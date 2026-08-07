import type { AgentAdapter } from "@birdybeep/agent-core";

import { detectCopilot } from "./detect";
import { installCopilot } from "./install";
import { normalizeCopilotEvent } from "./normalize";
import { copilotDoctor, copilotStatus } from "./status";
import { uninstallCopilot } from "./uninstall";

export const COPILOT_HARNESS_ID = "copilot";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The adapter envelope keeps the event name separate from the raw payload. */
export const copilotAdapter: AgentAdapter = {
  id: "copilot",
  displayName: "GitHub Copilot CLI",
  detect: () => detectCopilot(),
  install: (options) => installCopilot(options ?? {}),
  uninstall: (options) => uninstallCopilot(options ?? {}),
  status: () => copilotStatus(),
  doctor: () => copilotDoctor(),
  normalizeEvent: (input) => {
    const envelope = asRecord(input);
    const eventName = envelope["eventName"];
    return normalizeCopilotEvent(
      typeof eventName === "string" ? eventName : "",
      envelope["payload"],
    );
  },
};
