---
"@birdybeep/claude-code": minor
"@birdybeep/agent-core": minor
---

Emit a true end-of-session signal. Claude Code's `SessionEnd` hook is now registered and maps to a new non-notifying `session_ended` event type (mirrored in agent-core, in lockstep with the product wire contract), so a closed session settles terminal instead of lingering non-terminal until it ages out.
