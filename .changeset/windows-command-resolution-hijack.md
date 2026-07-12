---
"@birdybeep/agent-core": patch
"@birdybeep/opencode": patch
"@birdybeep/codex": patch
"@birdybeep/claude-code": patch
---

Security: close a Windows command-resolution hijack that could lead to silent RCE.

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
