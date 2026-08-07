# Example — GitHub Copilot CLI

[`birdybeep.json`](./birdybeep.json) is the exact config written by
`birdybeep agent install copilot` to `~/.copilot/hooks/birdybeep.json` (or
`$COPILOT_HOME/hooks/birdybeep.json`).

Copilot combines every JSON file in its hooks directory, so BirdyBeep owns a dedicated file and
never rewrites a user's other hook files. Each hook command includes its event name because Copilot
CLI's camelCase payload does not repeat that discriminator in the JSON sent on stdin. Both `bash`
and `powershell` commands are present for cross-platform installs.

Managed events: `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `agentStop`,
`subagentStop`, `errorOccurred`, and `sessionEnd`.

The integration reports `installed` immediately with no trust or restart step. The eight-event set,
payload shapes, and tokenless BYOK execution were verified against GitHub Copilot CLI `1.0.70` on
2026-08-06. Compatibility was additionally live-verified against GitHub-hosted Copilot CLI `1.0.78`
using macOS Keychain-backed OAuth on 2026-08-07. BirdyBeep drops the raw initial prompt, subsequent
prompts, tool arguments and results, transcript paths, subagent responses, and error details; only
safe lifecycle metadata is delivered.

Install is idempotent, writes the managed file with `0600` permissions, writes no token, preserves
all foreign hook files, and backs up a pre-existing `birdybeep.json` before replacing it. Uninstall
restores that backup or removes only BirdyBeep's from-scratch file.
