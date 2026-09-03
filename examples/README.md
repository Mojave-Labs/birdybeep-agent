# Generated config examples

These files show the configuration written by each BirdyBeep installer. CI compares them with fresh installations.

| Harness                                   | Config file                                    | Installed at                                                  |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| [Claude Code](./claude-code/README.md)    | [`settings.json`](./claude-code/settings.json) | `~/.claude/settings.json`                                     |
| [Codex](./codex/README.md)                | [`config.toml`](./codex/config.toml)           | `$CODEX_HOME/config.toml` or `~/.codex/config.toml`           |
| [OpenCode](./opencode/README.md)          | [`opencode.json`](./opencode/opencode.json)    | `$XDG_CONFIG_HOME/opencode/opencode.json` or its default path |
| [Cursor](./cursor/README.md)              | [`hooks.json`](./cursor/hooks.json)            | `~/.cursor/hooks.json`                                        |
| [GitHub Copilot CLI](./copilot/README.md) | [`birdybeep.json`](./copilot/birdybeep.json)   | `$COPILOT_HOME/hooks/birdybeep.json` or its default path      |

The examples show a new configuration containing only BirdyBeep-owned entries. Installers merge these entries with existing configuration. Machine tokens remain in the OS keychain or a restricted fallback file rather than harness configuration. Uninstall removes only BirdyBeep-owned entries and restores the original where appropriate.

See [Installing BirdyBeep](../docs/install.md) for activation and removal. See [Security and privacy](../docs/security.md) for token storage and transmitted fields.
