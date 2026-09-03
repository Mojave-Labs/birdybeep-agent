# @birdybeep/copilot

## 0.8.1

### Patch Changes

- d96031e: Shorten setup, pairing, diagnostic, and notification messages across the CLI and adapters. Documentation now states installation, security, and recovery behavior directly.
- Updated dependencies [d96031e]
- Updated dependencies [039cfa9]
- Updated dependencies [45322f3]
  - @birdybeep/agent-core@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [2cc183a]
- Updated dependencies [dd2bc79]
- Updated dependencies [e1ef7dd]
  - @birdybeep/agent-core@0.8.0

## 0.7.0

### Patch Changes

- b6dd9d6: Codex beeps now say what finished, and lead with the repo

  A Codex beep read "Codex finished" / "Turn complete" while the agent's own closing line was
  already in the payload. It is now the body, summarized to one line — the same treatment Claude
  Code beeps have always had. Both Codex surfaces are covered: the `Stop` hook and the `notify`
  turn-complete.

  Codex and OpenCode beeps also lead with `<repo> · <branch>`, like the other harnesses, so
  parallel sessions are told apart at a glance.

  Cursor and Copilot are unchanged: neither sends the agent's closing message on the events that
  beep, so there is nothing to summarize.

- 56c24e8: Queue events when the token store cannot be read, instead of reporting "not paired"

  A locked OS keychain read as "this machine has no token", so events fired while your screen was
  locked were discarded and `status`, `doctor` and `test` told a paired user to run `birdybeep pair`.

  Reading the token now distinguishes an empty store from one that will not answer:

  - Events fired while the store is unreadable are **queued** and deliver when it is readable again.
    The hook says so on stderr, and the `unpaired-events.json` record is not touched.
  - `status` reports `Paired:  unknown` with the reason, rather than `Paired:  no`.
  - `doctor`'s machine-token check names the store and gives the fix for that store — unlock the
    keychain, or repair the token file's path and permissions.
  - `birdybeep test` reports the store rather than "Offline" or "NOT PAIRED".
  - A token file that exists and fails to read is handled the same way, instead of erroring out of
    the hook — including one made unreachable by its parent directory, which previously read as
    "not paired" and discarded the event.

  With genuinely no token, events are still discarded and recorded, unchanged.

- Updated dependencies [5ce9fc0]
- Updated dependencies [b6dd9d6]
- Updated dependencies [56c24e8]
  - @birdybeep/agent-core@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [5202de0]
  - @birdybeep/agent-core@0.6.1

## 0.6.0

### Patch Changes

- 80ee2ed: A hook fire that sends nothing now says so and exits non-zero, instead of exiting 0 in silence.
  That covers an empty or unparseable payload, a payload that never arrived within the stdin read
  cap, and — new for `codex`, `opencode` and `copilot` — a payload that harness never fires. Every
  normal outcome, including a real harness event BirdyBeep deliberately does not map, still exits 0.

  Cursor: a failed tool call now produces a Beep (`postToolUseFailure` → `agent_failed`); the tool's
  error text and arguments are never sent. Cancelling a running tool yourself does not beep.
  `beforeSubmitPrompt` and `afterAgentResponse` are no longer registered — they could never produce a
  Beep — and installing removes them from a hooks file an earlier version patched.

- 6a684e8: Report coverage per harness build, so a desktop app that never beeps stops looking installed

  `birdybeep doctor` and `birdybeep status` now list every installed build of each harness on its
  own row, with the version that build actually runs:

  ```
  ✓  Claude Code: terminal CLI 2.1.227 — covered — 1 event(s) from this build
  ✗  Claude Code: Claude desktop app 2.1.229 — not covered — nothing has ever fired from this
     build, while terminal CLI 2.1.227 is delivering through the same config
  ```

  A harness is not one program. The terminal CLI and the engine a desktop app spawns are separate
  installs on separate update channels, and they share one config file — so "hooks installed" was a
  single answer covering both, and a desktop app that could not run the hook command looked exactly
  like one that could.

  - Detection returns a surface list: `claude` on PATH and the builds under
    `~/Library/Application Support/Claude/claude-code`; every `codex` on PATH and the one inside
    ChatGPT.app; `cursor-agent` and Cursor.app. Versions are read from the filesystem — no engine is
    run, because a `--version` probe answers for whichever build is first on PATH.
  - Coverage is graded on events actually observed from each build, not on config presence. Those
    observations are keyed by which SURFACE fired, not by version alone — two channels can ship the
    same version, and a version the terminal CLI has upgraded away from is not evidence about a
    desktop build. A build is only reported as a gap once another build of the same harness is
    delivering and it still is not; a shadowed PATH install is never blamed for not firing, and an
    observation whose surface the harness never named settles nothing rather than picking a row.
  - Codex, Copilot and OpenCode gained the stale-launcher check Claude Code and Cursor already had.
    OpenCode's is different in kind: it reports the launcher record its plugin spawns, since a
    missing one silently falls back to a `PATH` lookup that drops events with no error.
  - `birdybeep doctor` tells a migrated Codex user that turn-complete beeps are OFF right now,
    rather than the first-install wording.

  Desktop surfaces are reported on macOS, where the layouts are known. Elsewhere the terminal rows
  are reported and no desktop path is guessed.

- Updated dependencies [80ee2ed]
- Updated dependencies [6a684e8]
  - @birdybeep/agent-core@0.6.0

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
