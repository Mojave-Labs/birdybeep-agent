# @birdybeep/copilot

## 0.5.0

### Patch Changes

- f48eb6c: Report which build of a harness produced each event, in `harness_version`.

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

- 4d7888e: Fix hooks that never ran, and a Codex uninstall that deleted a user's own command

  - Copilot, OpenCode and Codex now invoke the CLI by absolute path instead of relying on the
    harness having the user's `PATH`. Copilot's PowerShell command uses the call operator and
    single-quoted paths; the OpenCode plugin spawns the path recorded at install time instead of
    searching `PATH`, which is what made its events disappear with no error.
  - `birdybeep agent install codex` now warns, prominently, when it has migrated an existing
    install: Codex trusts hooks by content, so the updated hooks are skipped until you open Codex
    and run `/hooks`. `birdybeep doctor` reports it until the hooks are trusted.
  - `birdybeep agent uninstall codex` removes only BirdyBeep's own command. A command of yours
    sharing a matcher entry with it is no longer deleted.

- b9b9610: Stop sending events that can never produce a notification.

  - `tool_started` and `tool_finished` are handled on your machine and no longer sent. On a measured
    18.45h Codex session that is 1016 of 1148 events — 88.5% of the traffic — none of which the
    backend could have notified on. They were also the bulk of the per-machine rate-limit budget, so
    a busy session could push real beeps into a 429.
  - `status` and `doctor` report those events instead: how many fired, when they started, and the
    count per type. A working install is still visibly working.
  - Every other event type is unchanged, including the ones that never beep: session start/resume/
    active/end and subagent start/stop still go, because the backend uses them for the sessions list,
    for "last seen", and to confirm Codex hook trust.
  - A `birdybeep hook` fire reports `filtered` under `--json` when it handled an event this way, and
    still exits 0.

- Updated dependencies [5153f4e]
- Updated dependencies [f48eb6c]
- Updated dependencies [4d7888e]
- Updated dependencies [b9b9610]
- Updated dependencies [b9e5c57]
  - @birdybeep/agent-core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [6817f70]
  - @birdybeep/agent-core@0.4.0

## 0.3.0

### Minor Changes

- 50390db: Add the GitHub Copilot CLI adapter and `copilot` harness id. The CLI installs a dedicated
  `~/.copilot/hooks/birdybeep.json`, passes each event name separately to
  `birdybeep hook copilot <event>`, and normalizes real Copilot lifecycle payloads without
  persisting raw prompts, tool arguments/results, transcript paths, error text, or subagent output.

### Patch Changes

- Updated dependencies [bbdbab7]
- Updated dependencies [50390db]
- Updated dependencies [6ad01d4]
- Updated dependencies [65abd2d]
- Updated dependencies [88f1dd5]
- Updated dependencies [8517fc8]
- Updated dependencies [859e150]
- Updated dependencies [c038f83]
- Updated dependencies [519f4ff]
- Updated dependencies [71d46d6]
  - @birdybeep/agent-core@0.3.0
