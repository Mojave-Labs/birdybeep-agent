/**
 * @birdybeep/claude-code — the Claude Code adapter (highest-priority integration).
 *
 * Placeholder for the A-MONOREPO scaffold. It deliberately imports from
 * `@birdybeep/agent-core` so the workspace cross-import is proven to type-check
 * and build (tsup keeps the workspace dep external, resolved via the workspace
 * symlink). Real detect/install/uninstall/normalizeEvent logic lands in the
 * a-claude epic tickets.
 */
import { type AdapterMeta, AGENT_CORE_VERSION } from "@birdybeep/agent-core";

/** Stable BirdyBeep harness id for Claude Code (§9.5). */
export const CLAUDE_CODE_HARNESS_ID = "claude_code";

/** agent-core version this adapter was built against — proves the cross-import. */
export const BUILT_AGAINST_AGENT_CORE: string = AGENT_CORE_VERSION;

/** Adapter identity, typed against agent-core's shared shape. */
export const claudeCodeMeta: AdapterMeta = { harness: CLAUDE_CODE_HARNESS_ID };
