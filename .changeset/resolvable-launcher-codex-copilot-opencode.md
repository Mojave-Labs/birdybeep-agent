---
"@birdybeep/agent-core": patch
"@birdybeep/codex": patch
"@birdybeep/copilot": patch
"@birdybeep/opencode": patch
---

Fix hooks that never ran, and a Codex uninstall that deleted a user's own command

- Copilot, OpenCode and Codex now invoke the CLI by absolute path instead of relying on the
  harness having the user's `PATH`. Copilot's PowerShell command uses the call operator and
  single-quoted paths; the OpenCode plugin spawns the path recorded at install time instead of
  searching `PATH`, which is what made its events disappear with no error.
- `birdybeep agent install codex` now warns, prominently, when it has migrated an existing
  install: Codex trusts hooks by content, so the updated hooks are skipped until you open Codex
  and run `/hooks`. `birdybeep doctor` reports it until the hooks are trusted.
- `birdybeep agent uninstall codex` removes only BirdyBeep's own command. A command of yours
  sharing a matcher entry with it is no longer deleted.
