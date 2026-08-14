---
"@birdybeep/claude-code": patch
"@birdybeep/cursor": patch
"@birdybeep/cli": patch
---

Deliver the events Cursor sends through its Claude Code compatibility bridge. Cursor desktop reads
`~/.claude/settings.json` and runs `birdybeep hook claude` with a Cursor payload; those fires are now
handled by the Cursor adapter and reported as `harness: "cursor"`, `routedFrom: "claude"` instead of
being dropped. A payload no adapter recognizes exits non-zero with a message naming the event, rather
than exiting 0 with no output.
