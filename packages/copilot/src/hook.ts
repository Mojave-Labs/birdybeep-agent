import { type HookResult, runAgentHook, type RunHookOptions } from "@birdybeep/agent-core";

import { copilotAdapter } from "./adapter";
import type { CopilotHookEventName } from "./install";

export function runCopilotHook(
  eventName: CopilotHookEventName,
  payload: unknown,
  options: RunHookOptions,
): Promise<HookResult> {
  return runAgentHook(copilotAdapter, { eventName, payload }, options);
}
