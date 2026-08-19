---
"@birdybeep/agent-core": patch
"@birdybeep/claude-code": patch
"@birdybeep/codex": patch
"@birdybeep/copilot": patch
---

Report which build of a harness produced each event, in `harness_version`.

The field is part of the event contract but no adapter ever filled it, so every event said
`(none)` — including on machines running the same harness twice from two update channels.

- **Claude Code** reports the engine that fired the hook, read from the environment it exports.
  The terminal CLI and the desktop app's bundled engine update separately and now report
  separately.
- **Codex** reports the `cli_version` from the session rollout the hook points at. The terminal
  CLI and the build inside ChatGPT.app share one `~/.codex/config.toml`, so this is what tells
  their events apart.
- **Copilot CLI** reports `COPILOT_CLI_BINARY_VERSION`.
- **Cursor** already reported `cursor_version`; unchanged.

The version always comes from the harness that actually ran, never from a `--version` probe of
whatever is on `PATH` — on a two-channel install that probe answers for the wrong build. A value
that is not version-shaped is dropped rather than reported.
