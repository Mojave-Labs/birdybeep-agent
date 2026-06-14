/**
 * The Claude Code hook entry: run one Claude Code hook fire through the shared pipeline
 * (normalizeEvent → dedup → send → fast return). Claude Code reads its config live and
 * needs no trust/restart gate, so this is a thin pass-through to `runAgentHook` — provided
 * for symmetry with `runCodexHook` / `runOpenCodeHook` so the CLI `hook` command treats
 * all three harnesses uniformly. The CLI `hook claude` command routes through this.
 */
import { type HookResult, runAgentHook, type RunHookOptions } from "@birdybeep/agent-core";

import { claudeCodeAdapter } from "./adapter";

/** Run one Claude Code hook fire end-to-end (normalize → dedup → send → fast return). */
export function runClaudeHook(rawInput: unknown, options: RunHookOptions): Promise<HookResult> {
  return runAgentHook(claudeCodeAdapter, rawInput, options);
}
