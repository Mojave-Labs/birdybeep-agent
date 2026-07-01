---
"@birdybeep/agent-core": patch
"@birdybeep/claude-code": patch
"@birdybeep/codex": patch
"@birdybeep/opencode": patch
---

Publish the agent-core and adapter packages (`@birdybeep/agent-core`, `@birdybeep/claude-code`, `@birdybeep/codex`, `@birdybeep/opencode`) to npm alongside the CLI. They are the CLI's runtime dependencies, so they now ship as public packages in the same fixed-version release.
