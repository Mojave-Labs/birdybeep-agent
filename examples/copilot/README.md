# GitHub Copilot CLI configuration

`birdybeep agent install copilot` writes [`birdybeep.json`](./birdybeep.json) to `$COPILOT_HOME/hooks/birdybeep.json` or `~/.copilot/hooks/birdybeep.json` with `0600` permissions. Existing hook files remain unchanged.

## Installed entries

The integration registers `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `agentStop`, `subagentStop`, `errorOccurred`, and `sessionEnd`. Each entry includes `bash` and `powershell` commands with the event name because the JSON payload does not include it.

## Existing configuration

Copilot combines files in its hooks directory. BirdyBeep owns only `birdybeep.json`. If that file already exists, installation writes a backup before replacing it.

BirdyBeep excludes prompts, tool arguments and results, transcript paths, subagent responses, and error details from transmitted events. The integration has been verified with GitHub Copilot CLI 1.0.70 and 1.0.78.

## Activation

No restart or trust step is required.

## Removal

`birdybeep agent uninstall copilot` restores the backup or removes BirdyBeep's file. Other hook files remain unchanged.
