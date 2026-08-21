# @birdybeep/opencode

## 0.7.0

### Patch Changes

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

### Patch Changes

- 4b31d09: Give the Claude Code, Codex and OpenCode malformed-config doctor checks the same actionable
  fix line Cursor got in birdybeep-agent-tu1 (birdybeep-agent-8kt).

  `birdybeep doctor` told users to "Fix or remove the malformed settings.json / config.toml /
  opencode.json, then re-run install" — naming neither the file nor the command, for the one
  failure `birdybeep agent install` cannot repair by itself (every installer parses before it
  writes, so a corrupt config makes it throw rather than heal). All three now print the real
  recovery, branching on whether the installer actually left a backup:

  - backup present → "Restore the BirdyBeep backup at `<config>.birdybeep-backup` over `<config>`
    (or delete the malformed file), then run `birdybeep agent install <harness>`."
  - no backup → "Fix the JSON/TOML in `<config>` (or delete it), then run
    `birdybeep agent install <harness>`."

  Verified per adapter by inducing the corrupt-config failure in a temp `HOME` with the built
  CLI, following the printed remedy, and confirming `doctor` comes back green — in both the
  backup and the no-backup branch. The unit tests now assert the concrete path + install command
  and are branch-discriminating (`not.toContain("birdybeep-backup")` on the no-backup branch —
  the backup string is a superstring of the config path, so without it a stuck ternary stayed
  green); the same assertion was backfilled into Cursor's test. `docs/troubleshooting.md`'s
  malformed-config block now shows both shapes and is consistent across all four adapters.

- bbdbab7: Claude Code events now also report the session name as a discrete `metadata.session_name`
  field, so the BirdyBeep app can offer "lead my push titles with the session name" as a phone-side
  preference instead of the adapter deciding the title format on your behalf. Previously the name
  was only ever baked into the title string, which the server cannot take apart.

  Nothing changes in what you see today: the adapter still leads its own title with the name, so
  the default (pass-through) title format is byte-identical. Sessions you have not named send no
  such field, and a server that doesn't read it simply ignores it — no wire-schema change, the
  field rides the existing open `metadata` object.

  The name is the one Claude Code puts on the `SessionStart` payload — set with `claude --name`, or a
  `/rename` from an earlier session. A mid-session `/rename` is not replayed to hooks, so it applies
  from the next session (unchanged from sv1, which leads the title with the same value).

  Privacy is unchanged in kind: `session_name` is a name YOU typed, never a session id and never
  path-derived, and it goes through the same redact → hash-paths → truncate pipeline as the title it
  mirrors, so a path or token typed into a session name is scrubbed in both places. Secrets are now
  redacted BEFORE the adapter's 120-char cap is applied: capping first could split a token below the
  length its pattern needs to match, leaving a readable prefix on the wire (a latent sv1 defect on the
  title path, fixed here for both surfaces).

  Codex, Cursor and OpenCode send no session name: the first two expose only opaque ids, and
  OpenCode's session `title` is generated from the conversation rather than typed by the user, so
  forwarding it would push prompt content off the machine. Each adapter's source now records that
  audit result, and `docs/security.md` documents the new field.

  Verified live end to end by `scripts/live-e2e-session-name.mjs` (new): the real built CLI fires
  real Claude Code hooks into the product worker running under `wrangler dev`, and the push the
  worker puts on the wire is composed from the field the real adapter sent.

- 6ad01d4: Fix OpenCode approval notifications silently dropping. Verified against a real `opencode` 1.18.1 event stream, the approval-request event is **`permission.asked`** (payload `{id, sessionID, permission, patterns, metadata, always, tool}`) — the type discriminator lives in `properties.permission` (e.g. `"bash"`/`"edit"`). An earlier SST-era SDK exposed **`permission.updated`** with a `type` field; the current Anomaly build no longer emits it (§21.1 harness drift).

  The adapter still forwarded and mapped the removed `permission.updated` name, so `permission.asked` was never forwarded and **every `approval_required` notification was dropped** — OpenCode users got no "the agent is waiting for you to approve" beep, one of the most important signals for a mobile notification app.

  The plugin now forwards `permission.asked`, and the normalizer maps it to `approval_required` reading the type from `properties.permission`. `permission.replied` is still dropped (the user's own reply, not an agent-attention moment), and the raw command (`patterns` / `metadata.command`) is never persisted — only the safe `permission_type` discriminator flows through. Verified end-to-end against the real `opencode` binary: a live session with `permission.bash = "ask"` now delivers `approval_required` to the ingest sink.

- 71d46d6: Security: close a Windows command-resolution hijack that could lead to silent RCE.

  The OpenCode plugin's event delivery spawned the bare name `birdybeep` with `shell: true`
  and no `cwd`, and every adapter's `detect()` probed the harness with a bare-name `execFile`
  (`codex`/`claude`/`opencode --version`). On Windows both `cmd.exe` and libuv resolve a bare
  name against the CURRENT WORKING DIRECTORY before PATH (applying PATHEXT), and these run with
  the harness's cwd = the repo the developer just opened. A hostile repo shipping
  `birdybeep.exe`/`.cmd`/`.bat` (or `codex.exe`, …) at its root could therefore get arbitrary
  code execution the moment a lifecycle event fired or `birdybeep agent install`/`doctor` ran —
  no prompt.

  Delivery and detection now resolve the target to an ABSOLUTE path via a new `agent-core`
  helper (`resolveOnPath`/`safeSpawn`/`safeExecFile`) that searches PATH only — never the cwd —
  and launch that absolute path with a trusted cwd and `windowsHide`. A Windows `.cmd`/`.bat`
  shim (which Node refuses to spawn without a shell) is run through the shell with the
  fully-qualified quoted path, so no cwd-first resolution can occur. If the CLI isn't on PATH
  the event is dropped with a one-time breadcrumb instead of falling back to a bare-name spawn.
  POSIX behavior is unchanged (its PATH search never included the cwd).

  On Windows the resolver now tries the real PATHEXT extensions (`.CMD`/`.EXE`/`.BAT`/…) and no
  longer prefers an extensionless PATH match. A standard `npm i -g` co-locates an extensionless
  `birdybeep` (a `#!/bin/sh` wrapper) with `birdybeep.cmd` in the same on-PATH directory;
  resolving the sh wrapper made it spawn without a shell, which Windows CreateProcess can't
  launch — silently dropping every OpenCode event and degrading version detection to "unknown".
  Picking the `.cmd` restores delivery on the exact platform this fix targets. On POSIX the
  resolver is now `execvp`-aware: a present-but-non-executable file earlier on PATH is skipped
  so the search continues to the real executable instead of failing with EACCES.

  The OpenCode plugin also delivers its event envelope on the CLI's STDIN reliably on Windows:
  piping the payload to a `.cmd` through `cmd.exe` did not dependably reach the batch shim's
  `node` grandchild (the bytes and their EOF were lost, dropping every event), so for a Windows
  `.cmd`/`.bat` the payload is now written to a strict-perm temp file and the shell's stdin is
  redirected from it (`… < "file"`), deleted when the child exits. POSIX and a Windows `.exe`
  still pipe straight to stdin. The CLI's "read stdin to EOF" contract is unchanged.

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

## 0.2.0

### Patch Changes

- @birdybeep/agent-core@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies [2aeeeeb]
  - @birdybeep/agent-core@0.1.0

## 0.0.3

### Patch Changes

- Updated dependencies [03f6f61]
  - @birdybeep/agent-core@0.0.3

## 0.0.2

### Patch Changes

- @birdybeep/agent-core@0.0.2

## 0.0.1

### Patch Changes

- 11b72f2: Add the `repository` field (with monorepo `directory`) to every published package.json, pointing at the public GitHub repo. Required for npm provenance and Trusted Publishing (OIDC) to validate the publishing repository, and it makes the "Repository" link on npmjs.com work.
- 8a385a5: Publish the agent-core and adapter packages (`@birdybeep/agent-core`, `@birdybeep/claude-code`, `@birdybeep/codex`, `@birdybeep/opencode`) to npm alongside the CLI. They are the CLI's runtime dependencies, so they now ship as public packages in the same fixed-version release.
- Updated dependencies [11b72f2]
- Updated dependencies [8a385a5]
  - @birdybeep/agent-core@0.0.1
