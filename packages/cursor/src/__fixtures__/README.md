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
