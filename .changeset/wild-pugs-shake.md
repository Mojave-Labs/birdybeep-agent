---
"@birdybeep/agent-core": minor
"@birdybeep/claude-code": minor
"@birdybeep/cursor": minor
---

Write a resolvable hook command, and Beep on Cursor MCP approval prompts.

**Hook commands no longer rely on `PATH`.** Cursor executes hooks from its own process, which gets
the `PATH` the OS gave the app rather than the one your shell has, so the bare `birdybeep hook …`
command the installer used to write was not found there — the hook exited 127 (`command not found`)
and no Beep was ever sent. This affected `~/.cursor/hooks.json` and `~/.claude/settings.json` (which
Cursor also loads and runs the same way). Install now writes the absolute Node and absolute CLI entry
point it is running under, which also covers the second half of the failure: the published bin's
`#!/usr/bin/env node` shebang needs `node` on `PATH` too, so an absolute CLI path alone still exits 127. Set `BIRDYBEEP_HOOK_COMMAND` to write a different launcher.

Because an absolute path can go stale (CLI reinstalled elsewhere, Node version switched),
`birdybeep doctor` gained a "Hook command resolves" check that names the missing path and points at
the repair, and `birdybeep agent install <harness>` now rewrites a drifted managed entry **in place**
instead of appending a second one. Entries written by earlier versions are recognized and repaired,
and `agent uninstall` removes either shape.

**Cursor: `beforeMCPExecution` is now registered** and maps to `approval_required`. It is the same
blocking permission gate as `beforeShellExecution`, so an MCP tool waiting on your approval now Beeps
exactly like a shell command does. As with the shell gate, the payload's content — the tool
arguments, the MCP server URL, and the server's launch command, which routinely carries an access
token — is never read. Only the tool and server names ride along, in metadata.
