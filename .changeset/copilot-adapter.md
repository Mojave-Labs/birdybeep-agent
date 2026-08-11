---
"@birdybeep/copilot": minor
"@birdybeep/agent-core": minor
"@birdybeep/cli": minor
---

Add the GitHub Copilot CLI adapter and `copilot` harness id. The CLI installs a dedicated
`~/.copilot/hooks/birdybeep.json`, passes each event name separately to
`birdybeep hook copilot <event>`, and normalizes real Copilot lifecycle payloads without
persisting raw prompts, tool arguments/results, transcript paths, error text, or subagent output.
