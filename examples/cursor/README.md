# Cursor configuration

`birdybeep agent install cursor` adds the entries in [`hooks.json`](./hooks.json) to `~/.cursor/hooks.json`. Existing settings and hooks remain in place.

## Installed entries

| Hook event             | Event                                    |
| ---------------------- | ---------------------------------------- |
| `sessionStart`         | session started                          |
| `sessionEnd`           | agent finished or session ended          |
| `beforeShellExecution` | shell command waiting for approval       |
| `beforeMCPExecution`   | MCP tool call waiting for approval       |
| `preToolUse`           | tool started                             |
| `postToolUse`          | tool finished                            |
| `postToolUseFailure`   | tool failed unless the user cancelled it |
| `stop`                 | turn finished                            |
| `subagentStart`        | subagent started                         |
| `subagentStop`         | subagent finished                        |

Each managed entry has this shape:

```json
{
  "command": "birdybeep hook cursor",
  "timeout": 30
}
```

On the installed machine, the command contains absolute paths to Node and the `birdybeep` entry point so hooks launched by the desktop app do not depend on the shell's `PATH`.

```json
{
  "command": "\"/usr/local/bin/node\" \"/usr/local/bin/birdybeep\" hook cursor",
  "timeout": 30
}
```

Set `BIRDYBEEP_HOOK_COMMAND` before installation to use another launcher:

```bash
BIRDYBEEP_HOOK_COMMAND="mise exec -- birdybeep" birdybeep agent install cursor
```

If Node or the CLI moves, `birdybeep doctor` reports the stale path. Run `birdybeep agent install cursor` to replace it.

## Existing configuration

The installer adds the `"version": 1` scaffold only when that key is absent. It appends BirdyBeep's entries to existing event lists and preserves other hooks. Before the first change, it writes `~/.cursor/hooks.json.birdybeep-backup`.

Cursor payloads include `user_email` and `transcript_path`; BirdyBeep excludes both. It hashes `workspace_roots[0]` before sending the event.

## Activation

Cursor reads `hooks.json` immediately. No restart or trust step is required. Headless `cursor-agent -p` currently emits only `sessionStart` and `sessionEnd`; the IDE also emits turn, tool, and approval events.

## Removal

`birdybeep agent uninstall cursor` removes BirdyBeep-owned entries and restores the original file where appropriate. Repeated installation updates the managed entry rather than adding a duplicate.
