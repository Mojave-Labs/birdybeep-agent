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
