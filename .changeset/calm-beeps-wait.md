---
"@birdybeep/agent-core": patch
"@birdybeep/cli": patch
"@birdybeep/claude-code": patch
"@birdybeep/codex": patch
"@birdybeep/copilot": patch
---

Allow healthy agent-event requests up to eight seconds to complete, and give managed hooks enough
time to finish that bounded send instead of falsely queueing already-accepted events.
