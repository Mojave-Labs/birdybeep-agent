---
"@birdybeep/cursor": minor
"@birdybeep/agent-core": minor
"@birdybeep/cli": minor
---

Add the Cursor adapter (`@birdybeep/cursor`) — a new harness integration.

Cursor reads `~/.cursor/hooks.json` (`{ "version": 1, "hooks": { "<eventName>": [ { command, timeout } ] } }`) and delivers each hook's event payload as JSON on **stdin**, so the managed command is `birdybeep hook cursor` (stdin-based, matching Claude Code). Install is non-destructive + idempotent (backs up the original, adds only BirdyBeep-managed entries, byte-for-byte reversible on uninstall) and there is **no trust/restart gate** — status is `installed` the moment the entries are written.

Event mapping (§10.1): `sessionStart` → `session_started`; `sessionEnd{final_status:"completed"}` → `agent_completed`; `sessionEnd{other}` → `session_ended`; `stop` → `agent_completed`; `beforeShellExecution` → `approval_required`; `preToolUse` → `tool_started`; `postToolUse` → `tool_finished`; `subagentStart`/`subagentStop` → `subagent_started`/`subagent_completed`; anything else → skipped.

**CLI-fires-a-subset caveat**: headless `cursor-agent -p` fires ONLY `sessionStart` + `sessionEnd` (a version-dependent subset — the IDE fires the full documented set). That is why a completed `sessionEnd` maps to `agent_completed`: it is the only completion signal CLI users ever get, so it must produce the "your agent finished" beep. We register the full documented event set anyway so IDE users are covered.

**Privacy**: Cursor payloads carry `user_email` (PII) and `transcript_path` (a local path). Both are **dropped entirely** — never copied into the event title/body/metadata/session-id/workspace. The only path touched is `workspace_roots[0]`, handed to the normalizer as `cwd` so it is hashed.

**Cross-repo lockstep (§16.4)**: `HARNESS_IDS` in `@birdybeep/agent-core` gains `"cursor"` (appended last, preserving every existing ordinal), and the vendored schema-parity fixture is updated in lockstep. The private `@birdybeep/shared` `HARNESS_IDS` MUST add `"cursor"` before prod ingest (`POST /v1/agent-events`) will accept cursor events — the two halves move together.
