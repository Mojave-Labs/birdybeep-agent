# Codex configuration

`birdybeep agent install codex` adds the lifecycle hooks in [`config.toml`](./config.toml) to `$CODEX_HOME/config.toml` or `~/.codex/config.toml`. Existing settings and hooks remain in place.

## Installed entries

Each managed entry runs `birdybeep hook codex` with a 10-second timeout.

| Hook event          | Event                                |
| ------------------- | ------------------------------------ |
| `SessionStart`      | session started                      |
| `PermissionRequest` | tool or command waiting for approval |
| `PostToolUse`       | tool finished                        |
| `SubagentStart`     | subagent started                     |
| `SubagentStop`      | subagent finished                    |
| `Stop`              | turn finished                        |

```toml
[[hooks.SessionStart]]
matcher = ""

[[hooks.SessionStart.hooks]]
type = "command"
command = "birdybeep hook codex"
timeout = 10
```

## Existing configuration

The installer appends BirdyBeep's entries and preserves other keys and hooks. It leaves a foreign
top-level `notify` program in place. A legacy BirdyBeep `notify` value is migrated as specified in
[Codex mapping](../../docs/SPEC.md#6-codex-mapping). Before the first change, the installer writes
`~/.codex/config.toml.birdybeep-backup`. If a later install must replace content that differs from
that backup, it writes an additional timestamped backup.

BirdyBeep does not install the top-level `notify` program. A foreign program that forwards
`agent-turn-complete` payloads to `birdybeep hook codex` continues to work. Duplicate completion
events are collapsed.

## Activation

Open Codex and run `/hooks`. Status remains `needs_trust` until a trusted lifecycle hook runs.

## Removal

`birdybeep agent uninstall codex` removes BirdyBeep-owned entries and restores the original configuration where appropriate. Repeated installation does not add duplicate hooks.
