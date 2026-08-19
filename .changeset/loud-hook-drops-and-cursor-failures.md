---
"@birdybeep/agent-core": patch
"@birdybeep/claude-code": patch
"@birdybeep/codex": patch
"@birdybeep/copilot": patch
"@birdybeep/cursor": patch
"@birdybeep/cli": patch
"@birdybeep/opencode": patch
---

A hook fire that sends nothing now says so and exits non-zero, instead of exiting 0 in silence.
That covers an empty or unparseable payload, a payload that never arrived within the stdin read
cap, and — new for `codex`, `opencode` and `copilot` — a payload that harness never fires. Every
normal outcome, including a real harness event BirdyBeep deliberately does not map, still exits 0.

Cursor: a failed tool call now produces a Beep (`postToolUseFailure` → `agent_failed`); the tool's
error text and arguments are never sent. Cancelling a running tool yourself does not beep.
`beforeSubmitPrompt` and `afterAgentResponse` are no longer registered — they could never produce a
Beep — and installing removes them from a hooks file an earlier version patched.
