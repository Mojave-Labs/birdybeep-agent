/**
 * The Cursor hook entry: run one Cursor hook fire through the shared pipeline
 * (normalizeEvent → dedup → send → fast return). Cursor reads its hooks.json live and needs
 * no trust/restart gate, so this is a thin pass-through to `runAgentHook` — provided for
 * symmetry with `runClaudeHook` / `runCodexHook` / `runOpenCodeHook` so the CLI `hook` command
 * treats every harness uniformly. The CLI `hook cursor` command routes through this.
 */
import { type HookResult, runAgentHook, type RunHookOptions } from "@birdybeep/agent-core";

import { cursorAdapter } from "./adapter";

/** Run one Cursor hook fire end-to-end (normalize → dedup → send → fast return). */
export function runCursorHook(rawInput: unknown, options: RunHookOptions): Promise<HookResult> {
  return runAgentHook(cursorAdapter, rawInput, options);
}
