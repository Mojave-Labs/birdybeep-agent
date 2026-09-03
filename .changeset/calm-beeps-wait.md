---
"@birdybeep/agent-core": patch
"@birdybeep/cli": patch
"@birdybeep/claude-code": patch
"@birdybeep/codex": patch
"@birdybeep/copilot": patch
---

Allow healthy agent-event requests up to eight seconds to complete, and give managed hooks enough
time to finish that bounded send instead of falsely queueing already-accepted events. Existing
10-second hook installs remain safe after package-only upgrades because stdin and token lookup now
reduce the request's remaining runtime budget. Legacy Copilot hook files also remain recognized as
BirdyBeep-owned during upgrade and uninstall, so removing the package cannot restore a stale hook.
