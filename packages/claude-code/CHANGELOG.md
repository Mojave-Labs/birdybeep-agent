# @birdybeep/claude-code

## 0.3.0

### Minor Changes

- 56efaf7: Claude Code push titles now lead with the session NAME when you've named a session (Claude
  Code `--name` / `/rename`), so a beep tells you WHICH session wants you — e.g. `billing refactor
— Claude Code finished` instead of `myapp · main — Claude Code finished`. When no name is set,
  the title is unchanged (repo · branch, then repo, then the plain action).

  Because Claude Code exposes `session_title` only on the SessionStart hook (never on Stop), the
  name is captured at SessionStart and cached, keyed by session id, in a strict-permission file
  (dir `0700`, file `0600`) under your user data dir — never repo-local. The cache is best-effort
  and fail-soft (a miss just falls back to repo · branch and never blocks or breaks the hook),
  cleaned up on SessionEnd, and swept by a TTL so it can't accumulate.

  Known limitation: a `/rename` performed AFTER SessionStart is not reflected in the title —
  Claude Code emits no hook that replays `session_title`, so the captured name is the one from
  SessionStart. Renaming before starting (or at startup) is picked up.

### Patch Changes

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

- Updated dependencies [6ad01d4]
- Updated dependencies [65abd2d]
- Updated dependencies [88f1dd5]
- Updated dependencies [8517fc8]
- Updated dependencies [c038f83]
- Updated dependencies [71d46d6]
  - @birdybeep/agent-core@0.3.0

## 0.2.0

### Patch Changes

- @birdybeep/agent-core@0.2.0

## 0.1.0

### Minor Changes

- 2aeeeeb: Emit a true end-of-session signal. Claude Code's `SessionEnd` hook is now registered and maps to a new non-notifying `session_ended` event type (mirrored in agent-core, in lockstep with the product wire contract), so a closed session settles terminal instead of lingering non-terminal until it ages out.

### Patch Changes

- Updated dependencies [2aeeeeb]
  - @birdybeep/agent-core@0.1.0

## 0.0.3

### Patch Changes

- 03f6f61: Claude Code notifications now say which session fired and what it did. The push title leads with `repo · branch` (pure-filesystem git detection, worktree- and detached-HEAD-aware, fail-soft), and the completion body is the summarized `last_assistant_message` instead of a fixed "Turn complete". Adds `detectRepoContext` to agent-core and populates `workspace.repo_name`/`branch` on events; no wire-schema change.
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
