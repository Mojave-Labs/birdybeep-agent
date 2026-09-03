# Installing BirdyBeep

`birdybeep setup` connects this machine, installs adapters for detected coding agents, and sends a
test Beep. Use the individual commands below when you need only one part of setup.

Installers preserve existing configuration and do not add duplicate entries. Before the first
modification, they write one backup. Machine tokens remain in the OS keychain or a restricted
fallback file.

## Supported harnesses

| Harness            | Target     | Config it patches                                              | Extra step              |
| ------------------ | ---------- | -------------------------------------------------------------- | ----------------------- |
| Claude Code        | `claude`   | `~/.claude/settings.json`                                      | none — live immediately |
| Codex              | `codex`    | `~/.codex/config.toml` (honors `$CODEX_HOME`)                  | one-time `/hooks` trust |
| OpenCode           | `opencode` | `~/.config/opencode/opencode.json` (honors `$XDG_CONFIG_HOME`) | restart OpenCode once   |
| Cursor             | `cursor`   | `~/.cursor/hooks.json`                                         | none — live immediately |
| GitHub Copilot CLI | `copilot`  | `~/.copilot/hooks/birdybeep.json` (honors `$COPILOT_HOME`)     | none — live immediately |

Anything not in that table is not supported today. See [Requirements for another adapter](#requirements-for-another-adapter)
for the support criteria. Each harness's generated configuration is under [`examples/`](../examples/README.md).

Tested harness versions are listed in the [support matrix](#support-matrix). Recheck compatibility
after updating a harness.

---

## Quick setup

### Install the CLI

The CLI is published to npm as [`@birdybeep/cli`](https://www.npmjs.com/package/@birdybeep/cli) and
provides the `birdybeep` command.

Install it globally with your package manager of choice:

```bash
npm install -g @birdybeep/cli
# or
pnpm add -g @birdybeep/cli
# or
yarn global add @birdybeep/cli
```

Confirm it's on your PATH:

```bash
birdybeep --version
birdybeep --help
```

The CLI works on macOS, Linux, and Windows.

---

### Run `birdybeep setup`

```bash
birdybeep setup
```

The command pairs this machine when needed, installs every supported harness it finds, prints a row
for each installed build, and sends a test Beep.

```text
✓ Paired to you@example.com.

coverage
   harness             build                        state
✓  Claude Code         terminal CLI 2.1.227         ready
✓  Claude Code         Claude desktop app 2.1.229   ready
!  Codex               terminal CLI 0.147.0         needs you
!  Codex               ChatGPT desktop app          needs you
     → Codex hooks installed.
     → Open Codex and run /hooks. Status changes from needs_trust after a lifecycle hook fires.
–  OpenCode            —                            not installed
✓  Cursor              cursor-agent CLI 2026.07.09  ready
✓  Cursor              Cursor.app 2.1.9             ready
–  GitHub Copilot CLI  —                            not installed

Not installed: OpenCode, GitHub Copilot CLI. Install either one, then run `birdybeep setup` again.

✓ Test event accepted for 1 registered device(s). Check your phone for a test Beep.
```

| State           | What it means                                                                                |
| --------------- | -------------------------------------------------------------------------------------------- |
| `ready`         | Wired up. It beeps on the next turn.                                                         |
| `beeping`       | Events from this build have already arrived.                                                 |
| `needs you`     | Installed, waiting on the one-time step under the row (Codex `/hooks`, an OpenCode restart). |
| `not covered`   | Another build of the same harness is delivering and this one never has — fix under the row.  |
| `not installed` | The harness isn't on this machine.                                                           |
| `failed`        | Its install errored; the message and a retry command are under the row.                      |

Re-run `birdybeep setup` after installing a new coding agent. It skips the phone step when the
machine already has a token, so it costs one command and no QR scan.

Flags: `--yes` / `--expect-email <addr>` behave as they do on `pair` (below); `--no-install` stops
after the machine token; `--no-test` skips the closing Beep.

## Manual setup and recovery

### Pair your machine

Pairing links this machine to your BirdyBeep account so events can be delivered to you.

```bash
birdybeep pair
```

This uses a device-flow pairing handshake. The CLI prints a scannable QR (on a terminal), its
complete link, and a display-only session code, then waits:

```text
To pair this machine, open the BirdyBeep app, tap “pair a machine”, and scan this QR or open the complete link:
   Scan or open:  https://birdybeep.com/pair#code=WXYZ-1234&s=<short-lived-approval-secret>
   Session code (display only; cannot approve by itself):  WXYZ-1234
Waiting for approval in the BirdyBeep app.
```

Approve it in the app, and the CLI asks you to confirm the account that approved it before it
trusts anything:

```text
Pair this machine to you@example.com? [y/N] y
✓ Paired to you@example.com.
```

`pair` then installs detected adapters, prints the coverage table, and sends a test Beep. Pass
`--no-install` to stop at the machine token.

Answer anything but `y`/`yes` and **no token is stored** (exit code 1). On a headless box or in CI,
pass `--expect-email <addr>` to pin the account that must have approved it (recommended) or `--yes`
to skip the question — without one of them a non-interactive `pair` fails closed instead of hanging.
Full detail in [Pairing → Confirming the approving account](./pairing.md#confirming-the-approving-account).

What this does with your token:

- The pairing link carries only short-lived pairing info — **never a durable token**.
- On success, the issued machine token is written to the **OS keychain** if one is available, or
  otherwise to a **strict-permission (0600) file** in your user config directory.
- The token is **never** written into harness config or any repo file.
- The server stores only a **hash** of the token. The token is shown once and can be revoked or
  rotated at any time from the mobile app.

> Note: the pairing backend endpoints are provisional and may change. If `pair` can't reach the
> backend yet, pair later — adapter installs don't require a token.

To unpair, run `birdybeep logout`, which removes the token from the keychain and the file fallback.
It's idempotent (safe to run when already logged out).

---

### Install one or all adapters

Adapters are the per-harness integrations. Installing one patches that harness's config so its
lifecycle hooks call back into `birdybeep hook <harness>`.

Install for every supported harness that's detected on this machine:

```bash
birdybeep agent install all
```

Or install one at a time:

```bash
birdybeep agent install claude
birdybeep agent install codex
birdybeep agent install opencode
birdybeep agent install cursor
birdybeep agent install copilot
```

`all` is the default, so `birdybeep agent install` with no target is equivalent to
`birdybeep agent install all`.

The command detects each supported harness first and **skips any that aren't installed** — it won't
create config for a harness you don't use. Output looks like this:

```text
✓  Claude Code: installed (/Users/you/.claude/settings.json)
✓  Codex: needs_trust (/Users/you/.codex/config.toml)
     → Codex hooks installed.
     → Open Codex and run /hooks. Status changes from needs_trust after a lifecycle hook fires.
✓  OpenCode: needs_restart (/Users/you/.config/opencode/opencode.json)
     → BirdyBeep plugin added to OpenCode.
     → Restart OpenCode. Status changes from needs_restart after the plugin emits an event.
✓  Cursor: installed (/Users/you/.cursor/hooks.json)
✓  GitHub Copilot CLI: installed (/Users/you/.copilot/hooks/birdybeep.json)
```

Re-run it and the idempotency shows in the output — the same statuses, with `(no changes)` in place
of the paths.

Use `--json` for machine-readable output (changed files, backups, required actions, and per-harness
status).

### Support matrix

| Harness            | Support   | Initial status                                     | Verification baseline                                          |
| ------------------ | --------- | -------------------------------------------------- | -------------------------------------------------------------- |
| Claude Code        | Supported | `installed`                                        | Live harness E2E                                               |
| Codex              | Supported | `needs_trust` until a trusted lifecycle hook fires | Live harness E2E                                               |
| OpenCode           | Supported | `needs_restart` until the restarted plugin emits   | Live harness E2E; event shapes reconciled with OpenCode 1.18.1 |
| Cursor             | Supported | `installed`                                        | Cursor Agent 2026.07.09 fixtures; Cursor IDE 3.14.27 live E2E  |
| GitHub Copilot CLI | Supported | `installed`                                        | CLI 1.0.70 BYOK + 1.0.78 GitHub OAuth live E2E (2026-08-07)    |

The version column is a tested baseline, not a maximum supported version. `birdybeep status` reports
the harness version detected on the current machine so API drift is visible in diagnostics.

### What each install writes

Every install backs up the original file once (a `.birdybeep-backup` sibling) before its first
change, adds only BirdyBeep-managed entries, and writes no token.

The snippets below show the portable form of the hook command. For **Claude Code and Cursor** the
installer instead writes the absolute path of the Node and the `birdybeep` entry point it is running
under — e.g. `"/usr/local/bin/node" "/usr/local/bin/birdybeep" hook cursor`. Both can have their
hooks executed from a GUI process — Cursor itself, and Cursor desktop's reading of
`~/.claude/settings.json` — which gets the `PATH` the OS gave the app rather than your shell's, so a
bare command exits 127 with `command not found`. Two consequences for those two harnesses:

- Set `BIRDYBEEP_HOOK_COMMAND` before installing to write a different launcher —
  `BIRDYBEEP_HOOK_COMMAND="mise exec -- birdybeep" birdybeep agent install all`.
- Move the CLI, or switch Node versions, and the written path stops resolving. `birdybeep doctor`
  reports the stale path; `birdybeep agent install <harness>` rewrites the entry in place (it
  replaces the managed entry rather than adding a second one).

**Codex and GitHub Copilot CLI** run their hooks from the terminal process you started them in, so
their managed commands are written as the plain `birdybeep hook <harness>` form shown below — the
same text committed under [`examples/`](../examples/README.md).

#### Claude Code

- **File:** `~/.claude/settings.json`
- **Change:** appends a BirdyBeep-managed entry to the relevant lifecycle hooks (`SessionStart`,
  `Notification`, `PermissionRequest`, `Stop`, `StopFailure`, `SubagentStop`, `SessionEnd`). Each
  entry runs `birdybeep hook claude` with a short timeout. Your own hooks are preserved.
- **Status:** `installed`. Claude Code reads its settings live, so there's nothing else to do — no
  restart, no trust step.

A managed hook entry looks like this:

```json
{
  "matcher": "",
  "hooks": [{ "type": "command", "command": "birdybeep hook claude", "timeout": 10 }]
}
```

#### Codex

- **File:** `~/.codex/config.toml` (honors `$CODEX_HOME` if set)
- **Change:** adds `[[hooks.X]]` lifecycle entries for `SessionStart`, `PermissionRequest`,
  `PostToolUse`, `SubagentStart`, `SubagentStop`, and `Stop` (turn complete). Each hook runs
  `birdybeep hook codex`. Your own config is preserved, including the top-level `notify` program,
  which BirdyBeep never writes — see
  [`examples/codex/README.md`](../examples/codex/README.md#the-notify-program).
- **Status:** `needs_trust` — see the gotcha below.

#### OpenCode

- **File:** `~/.config/opencode/opencode.json` (honors `$XDG_CONFIG_HOME`)
- **Change:** appends `"@birdybeep/opencode"` to the top-level `"plugin"` array. Your other plugins
  stay put.
- **Status:** `needs_restart` — see the gotcha below.

```json
{
  "plugin": ["@birdybeep/opencode"]
}
```

#### Cursor

- **File:** `~/.cursor/hooks.json`
- **Change:** ensures the `"version": 1` scaffold Cursor requires (only if absent — an existing
  value is left alone) and appends a BirdyBeep-managed entry to each consumed hook event:
  `sessionStart`, `sessionEnd`, `beforeShellExecution`, `beforeMCPExecution`, `preToolUse`,
  `postToolUse`, `postToolUseFailure`, `stop`, `subagentStart`, `subagentStop`. Each entry runs
  `birdybeep hook cursor`. Your own hooks are preserved. Installing also removes BirdyBeep's own
  entries for `beforeSubmitPrompt` and `afterAgentResponse`, which earlier versions registered.
- **Status:** `installed`. Cursor reads `hooks.json` live — no restart, no trust step.

```json
{
  "command": "birdybeep hook cursor",
  "timeout": 30
}
```

Headless `cursor-agent -p` fires only `sessionStart`/`sessionEnd` **as of `cursor-agent
2026.07.09`** (empirically captured 2026-07-15; it is a version-dependent subset), so on the CLI a
completed `sessionEnd` is your "agent finished" Beep; the IDE additionally fires `stop`, the tool
events, and the `beforeShellExecution` / `beforeMCPExecution` approval gates — a shell command and
an MCP tool call both Beep as "needs your approval". Cursor's payloads include `user_email` and
`transcript_path` — the adapter drops **both** outright and hashes the workspace root like every
other path.

The exact full generated file is committed at [`examples/cursor/hooks.json`](../examples/cursor/hooks.json)
and is byte-compared with the installer in the adapter test suite.

#### GitHub Copilot CLI

- **File:** `~/.copilot/hooks/birdybeep.json` (honors `$COPILOT_HOME`)
- **Change:** writes one dedicated hook file for Copilot's eight lifecycle events. Every entry has
  matching `bash` and `powershell` commands in the form `birdybeep hook copilot <event-name>`.
  Foreign files in the hooks directory are never modified.
- **Status:** `installed`. Copilot combines hook files without a trust or restart step.

Copilot's payload does not include its event name, so the event-specific command is required for
correct normalization. The file is written with `0600` permissions. Its exact contents are
committed at [`examples/copilot/birdybeep.json`](../examples/copilot/birdybeep.json) and guarded
against installer drift in tests.

---

## Adapter reference

Codex and OpenCode require one action after installation. Claude Code, Cursor, and GitHub Copilot
CLI do not.

### Codex: `needs_trust`

Codex skips hooks it hasn't trusted, so a fresh install reports `needs_trust`. To grant trust:

1. Open Codex.
2. Run `/hooks`.

Status remains `needs_trust` until a trusted lifecycle hook fires.

### OpenCode: `needs_restart`

OpenCode loads plugins at startup. Restart OpenCode after installation. Status remains
`needs_restart` until the plugin emits an event.

---

### Check status and send a test

Check the overall state:

```bash
birdybeep status
```

```text
Machine: MacBook Pro (macos)
Paired:  yes
Integrations:
  Claude Code: installed
  Codex: needs_trust
  OpenCode: needs_restart
  Cursor: installed
  GitHub Copilot CLI: installed
Queue:   0 queued → 0 delivered, 0 remaining
```

(When you aren't paired, the second line reads ``Paired: no. Run `birdybeep pair`.`` and the
command exits 1.)

`status` shows your machine identity, pairing state, per-harness integration status, and the local
queue depth. It opportunistically drains any queued events while it runs, and exits non-zero if
you're not paired (handy for scripts). Add `--json` for the machine-readable form.

Send a real test event end-to-end:

```bash
birdybeep test
```

This pushes a test event through the actual sender path and reports whether it was delivered,
queued for retry, or not sent:

```text
✗ This machine is not paired. Run `birdybeep pair`. No event was sent or queued.
```

If everything is paired and reachable, you should get a Beep on your phone.

For a deeper diagnosis, run:

```bash
birdybeep doctor
```

`doctor` checks your token, each adapter (including `needs_trust` / `needs_restart` / error states),
the local queue, and backend reachability — printing a specific fix for each failure. It drains the
queue as it goes and exits non-zero if anything is wrong.

---

### Update notices

When you run any command, the CLI prints a one-line notice to **stderr** if a newer
`@birdybeep/cli` has been published:

```text
a new version of birdybeep is available: 0.1.0 → 0.2.0
upgrade with: npm install -g @birdybeep/cli@latest
```

The CLI checks npm for a newer release at most once a day. It skips the check for hook execution,
JSON or non-interactive output, pipes, and CI. Disable notices with `NO_UPDATE_NOTIFIER=1` or
`BIRDYBEEP_NO_UPDATE_NOTIFIER=1`. A custom `npm_config_registry` is respected. Updates are never
installed automatically.

Once you've upgraded, re-running `birdybeep agent install all` is safe (idempotent) and refreshes any
adapter config that changed between versions.

---

## Uninstall

Uninstall removes BirdyBeep-owned entries and restores configuration from the backup where
appropriate.

```bash
birdybeep agent uninstall all
```

Or per harness:

```bash
birdybeep agent uninstall claude
birdybeep agent uninstall codex
birdybeep agent uninstall opencode
birdybeep agent uninstall cursor
birdybeep agent uninstall copilot
```

Running uninstall when nothing is installed is a no-op:

```text
✓  Claude Code: removed (/Users/you/.claude/settings.json)
–  Codex: nothing to remove
```

Run `birdybeep unpair` to revoke the machine on the server and delete its local token. Run
`birdybeep logout` to delete only the local token.

---

## Requirements for another adapter

BirdyBeep supports Claude Code, Codex, OpenCode, Cursor, and GitHub Copilot CLI. A new adapter needs:

- a supported lifecycle hook or plugin API;
- event fields that can be mapped without forwarding session content;
- a reversible user-level installation;
- an end-to-end test using the current harness.

Harnesses evaluated on 2026-07-15:

| Harness        | Why there's no adapter                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------- |
| **Windsurf**   | Folded into Devin; no separately supported agent CLI to hook.                                     |
| **Roo Code**   | Discontinued (2026-05-15).                                                                        |
| **Continue**   | Acquired by Cursor (2026-06-16); the Cursor adapter is the successor path.                        |
| **Gemini CLI** | Individual access cut off (2026-06-18), folded toward Antigravity — no stable individual surface. |

This table is a dated record, not a permanent decision. Open an issue to request another harness.
Implementation requirements are in [Adapter development](./adapter-development.md).

---

## Security and privacy

See [Security and privacy](./security.md) for transmitted fields, filtering rules, token storage,
local queue behavior, and backend storage.
