# Claude Code configuration

`birdybeep agent install claude` adds the entries in [`settings.json`](./settings.json) to `~/.claude/settings.json`. Existing settings and hooks remain in place.

## Installed entries

Each managed entry runs `birdybeep hook claude` with a 10-second timeout.

| Hook event          | Event                                |
| ------------------- | ------------------------------------ |
| `SessionStart`      | session started                      |
| `Notification`      | notification or prompt               |
| `PermissionRequest` | tool or command waiting for approval |
| `Stop`              | turn finished                        |
| `StopFailure`       | turn failed                          |
| `SubagentStop`      | subagent finished                    |
| `SessionEnd`        | session ended                        |

```json
{
  "matcher": "",
  "hooks": [
    {
      "type": "command",
      "command": "birdybeep hook claude",
      "timeout": 10
    }
  ]
}
```

## Existing configuration

The installer appends BirdyBeep's entries to the seven hook lists and preserves other settings and hooks. Before the first change, it writes `~/.claude/settings.json.birdybeep-backup`.

## Activation

Claude Code reads `settings.json` immediately. No restart or trust step is required.

## Removal

`birdybeep agent uninstall claude` removes BirdyBeep-owned entries and restores the original file where appropriate. Repeated installation does not add duplicate hooks.
