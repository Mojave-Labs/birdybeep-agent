/**
 * Recognizing a Cursor hook payload — including one that arrives at the WRONG hook command.
 *
 * birdybeep-agent-gcgp.1: Cursor desktop ships a Claude Code compatibility bridge. It reads
 * `~/.claude/settings.json` (its own hook log prints `Claude user config path: …/.claude/settings.json`)
 * and executes the commands it finds there — so on any machine with BirdyBeep's Claude Code
 * hooks installed, Cursor runs `birdybeep hook claude`. It does NOT translate the payload: it
 * hands our Claude adapter a CURSOR payload, keyed by Cursor's own lowercase step names.
 *
 * The bridge's Claude-event → Cursor-step table (matches Cursor's third-party-hooks docs):
 *   PreToolUse→preToolUse · PostToolUse→postToolUse · UserPromptSubmit→beforeSubmitPrompt ·
 *   Stop→stop · SubagentStop→subagentStop · SessionStart→sessionStart · SessionEnd→sessionEnd ·
 *   PreCompact→preCompact · Notification and PermissionRequest are unsupported (dropped by Cursor).
 *
 * The CLI uses {@link isCursorHookPayload} to route those fires to the Cursor adapter, so they
 * normalize correctly and are attributed to `harness: "cursor"` rather than masquerading as
 * Claude Code.
 */

/**
 * Every Cursor hook step name. Used to tell a Cursor payload we deliberately don't map (a
 * quiet skip) from one we don't recognize at all (a loud failure) — never for routing, so a
 * step Cursor adds later still reaches the Cursor adapter.
 *
 * All 21 members of Cursor's own `HookStep` enum, read out of the shipped
 * `packages/hooks/src/hook-step.ts` in `workbench.desktop.main.js` (Cursor 3.x, re-read
 * 2026-08-19 for birdybeep-agent-gcgp.14). Previously this list was the subset observed in
 * the hook-service log, which omitted five real steps — including `beforeMCPExecution`, which
 * BirdyBeep itself registers.
 */
export const CURSOR_HOOK_EVENTS: readonly string[] = [
  "afterAgentResponse",
  "afterAgentThought",
  "afterFileEdit",
  "afterMCPExecution",
  "afterShellExecution",
  "afterTabFileEdit",
  "beforeMCPExecution",
  "beforeReadFile",
  "beforeShellExecution",
  "beforeSubmitPrompt",
  "beforeTabFileRead",
  "postToolUse",
  "postToolUseFailure",
  "preCompact",
  "preToolUse",
  "sessionEnd",
  "sessionStart",
  "stop",
  "subagentStart",
  "subagentStop",
  "workspaceOpen",
];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Is this a Cursor hook step name we know about? */
export function isCursorHookEventName(value: unknown): boolean {
  return typeof value === "string" && CURSOR_HOOK_EVENTS.includes(value);
}

/**
 * Does this payload come from Cursor? True when it carries a string `hook_event_name` AND at
 * least one field only Cursor sends — `cursor_version` (present on every captured payload) or
 * the `workspace_roots` + `conversation_id` pair. Claude Code's hook payloads carry none of
 * those, so this can never reclassify a genuine Claude Code fire.
 */
export function isCursorHookPayload(input: unknown): boolean {
  const payload = asRecord(input);
  if (typeof payload["hook_event_name"] !== "string") return false;
  if (typeof payload["cursor_version"] === "string") return true;
  return (
    Array.isArray(payload["workspace_roots"]) && typeof payload["conversation_id"] === "string"
  );
}
