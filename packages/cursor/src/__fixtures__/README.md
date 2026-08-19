# Cursor hook fixtures

Captured from a real `cursor-agent 2026.07.09` headless session (`-p --trust`) on
2026-07-15, then **redacted**: `user_email` → `user@example.com`, session UUIDs →
fixed placeholder, workspace/transcript paths → generic. Shapes/field-sets are
byte-faithful to the real payloads; only PII/paths are replaced.

Empirical note: headless `cursor-agent -p` fires ONLY `sessionStart` + `sessionEnd`
(no `stop`/`afterAgentResponse`/tool hooks — a version-dependent subset; the IDE
fires the full set). The adapter must dispatch on `hook_event_name`, hash
`workspace_roots[0]`, and DROP `user_email` + `transcript_path` before sending.

`bridge-claude-*.json` are different: they were captured from **Cursor desktop 3.14.27**'s
own hook log (`~/Library/Application Support/Cursor/logs/**/cursor.hooks.*.log`) on
2026-08-07, where Cursor's Claude Code compatibility bridge ran `birdybeep hook claude`
with these payloads. Same redaction. They are Cursor payloads arriving at the Claude hook —
see `../bridge.ts`.

`beforeMCPExecution.json` is the one fixture that is not a capture. Cursor only fires
that step from the IDE, for an MCP tool call, and it is registered by BirdyBeep for the
first time here (gcgp.9) — so there was no logged payload to copy. The field set is read
off Cursor 3.15.6's own source instead: the base payload from a captured session, plus
`tool_name`, `tool_input` (a JSON **string**), `mcp_server_name`, and `command` /
`mcp_server_url`, exactly as
`extensions/cursor-agent-exec/dist/main.js` assembles them before
`executeHookForStep(beforeMCPExecution, …)`. `tool_input` and `command` are the reason the
mapper reads neither: the launch line routinely carries an API token.

`beforeSubmitPrompt.json` and `afterAgentResponse.json` were captured from **Cursor desktop
3.14.27**'s own hook log on 2026-08-07 (same log and same redaction as `bridge-claude-*.json`);
`prompt` and `text` — the raw user prompt and the raw assistant response — are replaced with
marker strings. They are the evidence for gcgp.17's de-registration of both steps: the payloads
are entirely content plus a token count, with nothing a §10.1 event could carry.

`postToolUseFailure*.json` are the second pair that are not captures. No `postToolUseFailure`
fire exists in the local Cursor log corpus (0 across 12 sessions of `cursor.hooks.*.log`,
2026-06-11 → 2026-08-18), so the field set is read off Cursor's own shipped schema instead: the
`agent.v1.PostToolUseFailureRequestQuery` protobuf message in `workbench.desktop.main.js`
(`tool_name`, `tool_input`, `error_message`, `failure_type`, `duration_ms`, `tool_use_id`,
`is_interrupt`, plus the conversation/model fields), wrapped in the envelope every captured
3.14.27 payload carries. `error_message` and `tool_input` are why the mapper reads neither — a
tool's raw error routinely holds paths, command output and credentials. The `-interrupt` variant
is the `is_interrupt: true` shape Cursor sends when the user cancels a running tool.
