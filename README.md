# BirdyBeep

[![CI](https://img.shields.io/github/actions/workflow/status/Mojave-Labs/birdybeep-agent/ci.yml?branch=main&label=CI&logo=github&logoColor=white)](https://github.com/Mojave-Labs/birdybeep-agent/actions/workflows/ci.yml?query=branch%3Amain)
[![npm](https://img.shields.io/npm/v/%40birdybeep%2Fcli?logo=npm&label=%40birdybeep%2Fcli)](https://www.npmjs.com/package/@birdybeep/cli)
[![node](https://img.shields.io/node/v/%40birdybeep%2Fcli?logo=node.js&logoColor=white&label=node)](https://nodejs.org)
[![platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-informational)](https://github.com/Mojave-Labs/birdybeep-agent/actions/workflows/ci.yml?query=branch%3Amain)
[![license](https://img.shields.io/npm/l/%40birdybeep%2Fcli?color=blue)](./LICENSE)

**Mobile notifications for your AI coding agent.** When Claude Code, Codex, OpenCode, Cursor, or
GitHub Copilot CLI needs you — an approval, some input, a finished run, an idle session, a failure —
BirdyBeep sends a push to your phone so you can walk away from the terminal and still know the
moment your agent is waiting on you.

---

## How it works

Install once per machine and pair it with the mobile app. Each supported agent then emits
lifecycle events through a local hook:

```text
Harness hook/plugin
  → birdybeep hook <harness>     # reads the machine token, normalizes the event
    → redacts secrets, hashes absolute paths, truncates long fields
    → sends to the BirdyBeep API with a short timeout
    → queues locally on failure, then returns fast
```

There is no background daemon. The hook runs only when your agent fires an event and completes in
a few milliseconds. If delivery fails, the event lands in a local retry queue and is sent later; it
never blocks your harness.

## What it touches on your machine

- **Per-harness config in your home directory** — e.g. `~/.claude/settings.json`,
  `~/.codex/config.toml`, `~/.config/opencode/opencode.json`, `~/.cursor/hooks.json`, and
  `~/.copilot/hooks/birdybeep.json`. Installs are idempotent, back up the original once, and add
  only BirdyBeep-managed entries. (See [Per-harness details](#per-harness-details).)
- **A local event queue** — best-effort, ~24h retention, at most 500 entries, strict file
  permissions. It holds only events that couldn't be delivered immediately, and nothing at all until
  the machine is paired. It is not an audit log, and `birdybeep queue clear` empties it.
- **One machine token** — stored in your OS keychain when available, otherwise a strict-permission
  (`0600`) file in your user config directory. It is never written into harness config or any repo
  file.

## Install

```bash
npm install -g @birdybeep/cli   # or pnpm add -g / yarn global add

birdybeep setup                 # pair, wire up every coding agent on this machine, send a test Beep
```

`setup` scans its QR (or open the complete link), asks you to confirm the account that approved it,
installs every supported harness it finds, and prints what each installed build will do:

```text
✓ Paired to you@example.com.

coverage
   harness             build                        state
✓  Claude Code         terminal CLI 2.1.227         ready
✓  Claude Code         Claude desktop app 2.1.229   ready
!  Codex               terminal CLI 0.147.0         needs you
     → Codex may require one-time hook trust. Open Codex and run /hooks.
–  OpenCode            —                            not installed

Not installed: OpenCode. Install any of them, then run `birdybeep setup` again to wire it up.

✓ Test event delivered — check your phone for a test Beep.
```

Run it again after installing a new coding agent — it skips the phone step when the machine is
already paired. `birdybeep pair` runs the identical flow.

Installs are idempotent — re-running produces the same result. They back up existing config, add
only BirdyBeep-managed entries, print the files they changed, and install at the user/global level.
To do one harness at a time, use `birdybeep agent install <harness>`.

Some harnesses need one extra step after install — see [Per-harness details](#per-harness-details).

## Uninstall

```bash
birdybeep agent uninstall all   # or: claude | codex | opencode | cursor | copilot
birdybeep logout                # remove the machine token (idempotent)
```

Uninstall removes only BirdyBeep-managed entries and restores your config from the backup, so your
settings come back exactly as they were. `logout` clears the local token from both the keychain and
the file fallback.

## Commands

Run `birdybeep <command> --help` for per-command help.

| Command                                                                     | What it does                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `birdybeep setup`                                                           | The one-step setup: pair, install every detected harness, print a per-build coverage table, and send a test Beep. Skips pairing when the machine already has a token.                                                                         |
| `birdybeep pair [--no-install] [--no-test]`                                 | The same flow, always re-pairing. `--no-install` stops after the machine token; `--no-test` skips the closing Beep.                                                                                                                           |
| `birdybeep logout`                                                          | Removes the machine token (keychain + file fallback). Idempotent. Same as `unpair`.                                                                                                                                                           |
| `birdybeep unpair`                                                          | Unpairs this machine — removes the machine token (keychain + file fallback). Idempotent. Same as `logout`.                                                                                                                                    |
| `birdybeep status`                                                          | Machine + pairing state, per-harness integration status, and queue depth. Drains the queue opportunistically; exits non-zero if not paired.                                                                                                   |
| `birdybeep test`                                                            | Sends a test event through the real sender path and reports whether it was delivered, queued for retry — naming which of offline, a backend that asked for a retry, or an unreadable token store parked it — or not sent at all (not paired). |
| `birdybeep doctor`                                                          | Checks the token, each adapter (`needs_trust` / `needs_restart` / `error`), the queue, and backend reachability; prints a fix per failure; drains the queue; non-zero on any failure.                                                         |
| `birdybeep agent install [all\|claude\|codex\|opencode\|cursor\|copilot]`   | Detect + install per harness (idempotent, backs up, managed entries only, no token).                                                                                                                                                          |
| `birdybeep agent uninstall [all\|claude\|codex\|opencode\|cursor\|copilot]` | Remove only managed entries and restore from backup.                                                                                                                                                                                          |
| `birdybeep queue clear`                                                     | Drop all locally-queued events (debug).                                                                                                                                                                                                       |

Two commands are invoked by BirdyBeep itself, not by you:

- `birdybeep hook <claude\|codex\|opencode\|cursor\|copilot>` — the hook the installed harness
  config calls. It reads the event payload, normalizes and redacts it, sends with a short timeout,
  queues on failure, and always returns fast and exits 0. Copilot's managed commands also pass the
  event name as a final argument because its payload does not contain one.
- `birdybeep report-status` — posts each adapter's pre-event integration status to the backend.

### Update notices

There's no `update` command. When you run a command, the CLI prints a one-line notice to stderr if
a newer `@birdybeep/cli` has been published:

```text
a new version of birdybeep is available: 0.1.0 → 0.2.0
upgrade with: npm install -g @birdybeep/cli@latest
```

The check is cached (refreshed from the npm registry at most once a day), never runs on the `hook`
hot path, and is skipped for `--json`, `--non-interactive`, non-TTY output, and CI. Silence it with
`NO_UPDATE_NOTIFIER=1` (or `BIRDYBEEP_NO_UPDATE_NOTIFIER=1`).

### Global flags & exit codes

| Flag                | Effect                                        |
| ------------------- | --------------------------------------------- |
| `--json`            | Machine-readable JSON output.                 |
| `--non-interactive` | Never prompt; fail fast if input is required. |
| `-h`, `--help`      | Show help (root or per-command).              |
| `-v`, `--version`   | Show the CLI version.                         |

Exit codes: **`0`** ok · **`1`** error · **`2`** usage.

`birdybeep pair` adds two of its own:

| Flag                    | Effect                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `--yes`, `-y`           | Skip the approving-account confirmation (headless/CI).                                  |
| `--expect-email <addr>` | Only trust the pairing if this account approved it — otherwise fail and store no token. |

After the backend mints a machine token, `pair` shows the account that approved the machine and
asks `Pair this machine to <email>? [y/N]` before storing anything. Decline and no token is
written. The question is read from stdin when stdin is a terminal, and on macOS/Linux otherwise from
the controlling terminal (`/dev/tty`), so a pipe-backed shell still gets prompted. With neither
available (a script, CI, `--non-interactive`, or any Windows shell without a real TTY) it fails
closed instead of hanging. See
[`docs/pairing.md`](./docs/pairing.md#confirming-the-approving-account).

## Per-harness details

| Harness            | Target     | Config it patches                  | After install                                      |
| ------------------ | ---------- | ---------------------------------- | -------------------------------------------------- |
| Claude Code        | `claude`   | `~/.claude/settings.json`          | `installed` immediately                            |
| Codex              | `codex`    | `~/.codex/config.toml`             | `needs_trust` until a trusted lifecycle hook fires |
| OpenCode           | `opencode` | `~/.config/opencode/opencode.json` | `needs_restart` until the restarted plugin emits   |
| Cursor             | `cursor`   | `~/.cursor/hooks.json`             | `installed` immediately                            |
| GitHub Copilot CLI | `copilot`  | `~/.copilot/hooks/birdybeep.json`  | `installed` immediately                            |

All installs are idempotent, back up the original once, add only BirdyBeep-managed entries, and
write no token. The harness versions each adapter was verified against are in the
[support matrix](./docs/install.md#support-matrix).

- **Claude Code** — patches the hooks in `~/.claude/settings.json` to invoke
  `birdybeep hook claude`. Claude Code reads its config live, so the integration is active
  immediately.
- **Codex** — patches `~/.codex/config.toml` with `[[hooks.X]]` lifecycle hooks (SessionStart,
  PermissionRequest, PostToolUse, SubagentStart, SubagentStop, Stop), all invoking
  `birdybeep hook codex`. The top-level `notify` program is left alone. Codex requires a one-time
  hook trust: open Codex and run `/hooks`. Until a trusted lifecycle hook actually fires, status
  shows `needs_trust`.
- **OpenCode** — adds `@birdybeep/opencode` to the `plugin` array in
  `~/.config/opencode/opencode.json` (honors `XDG_CONFIG_HOME`). OpenCode loads plugins only at
  startup, so restart OpenCode. Until the first event after restart, status shows `needs_restart`.
- **Cursor** — patches `~/.cursor/hooks.json` (adding the `"version": 1` scaffold only if absent)
  with an entry per consumed hook event — `sessionStart`, `sessionEnd`, `beforeShellExecution`,
  `preToolUse`, `postToolUse`, `stop`, `subagentStart`, `subagentStop`, plus three registered for
  forward-compatibility — each invoking `birdybeep hook cursor`. Cursor reads `hooks.json` live, so
  it is active immediately. Headless `cursor-agent -p` fires only `sessionStart`/`sessionEnd`
  today, so a completed `sessionEnd` is the CLI user's "finished" Beep. Cursor payloads carry
  `user_email` and `transcript_path`; the adapter drops both.
- **GitHub Copilot CLI** — writes the dedicated `~/.copilot/hooks/birdybeep.json` file (honors
  `COPILOT_HOME`) without touching other files in the hooks directory. Each event invokes
  `birdybeep hook copilot <event-name>`. Copilot combines hook files live, so status is `installed`
  immediately.

`birdybeep status` and `birdybeep doctor` surface these states and tell you what to do.

Harnesses we surveyed and did not ship an adapter for, plus the bar a new one has to clear, are in
[`docs/install.md`](./docs/install.md#harness-support--roadmap). The exact generated config for
every harness is committed under [`examples/`](./examples/README.md).

## Security & privacy

Before an event is sent, the local hook:

- **Hashes absolute paths** to opaque `h_<16-hex>` tokens (your `cwd` is always hashed).
- **Redacts secret-shaped strings** — AWS / GitHub / OpenAI / Slack keys, JWTs, and `key=value`
  secrets become `[redacted]`.
- **Truncates** long fields (title 200, body 2000, metadata-value 500 chars) under a 16 KB cap.
- **Drops raw user and assistant content.** Codex drops input messages, the last assistant message,
  and tool input; OpenCode drops tool args, permission titles, and error messages; Cursor drops
  prompts, email, transcript paths, and tool data; Copilot drops prompts, tool arguments and
  results, transcripts, subagent responses, and error details. Only tool name and status flow
  through.

The event carries an event id and type, timestamp, harness, session id, machine label, OS, a hashed
workspace, status, a short title/body, and optional metadata. The backend does not persist
notification title/body by default — only metadata, hashes, and delivery + session status.

Tokens live in your OS keychain (or a strict-permission file fallback) and are never written into
harness config or any repo file. The server stores only token hashes; the token is shown once and
can be revoked or rotated from the mobile app.

Exact redaction patterns and the wire schema are in [`docs/security.md`](./docs/security.md).

## Documentation

| Doc                                                            | Contents                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`docs/install.md`](./docs/install.md)                         | Detailed install + uninstall, per harness.                          |
| [`docs/pairing.md`](./docs/pairing.md)                         | How `pair` pairing works.                                           |
| [`docs/security.md`](./docs/security.md)                       | Tokens, redaction, and exactly what data is sent.                   |
| [`docs/troubleshooting.md`](./docs/troubleshooting.md)         | `doctor`, `needs_trust`, `needs_restart`, offline queue.            |
| [`docs/adapter-development.md`](./docs/adapter-development.md) | Building and patching adapters.                                     |
| [`docs/SPEC.md`](./docs/SPEC.md)                               | The normative integration spec (event model, per-harness mappings). |

## Packages

| Package                  | Description                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `@birdybeep/cli`         | The `birdybeep` CLI: pair, logout, unpair, status, test, doctor, agent install/uninstall, hook. |
| `@birdybeep/agent-core`  | Event schema, normalizer/redaction, local queue, sender, token store, adapter interface.        |
| `@birdybeep/claude-code` | Claude Code adapter + hook templates.                                                           |
| `@birdybeep/codex`       | Codex adapter + config templates.                                                               |
| `@birdybeep/opencode`    | OpenCode plugin/adapter.                                                                        |
| `@birdybeep/cursor`      | Cursor adapter + hooks config templates.                                                        |
| `@birdybeep/copilot`     | GitHub Copilot CLI adapter + dedicated hooks config.                                            |

## Develop

```bash
pnpm install
pnpm build       # turbo run build — tsup ESM/CJS + d.ts per package
pnpm lint
pnpm typecheck
pnpm test
```

Developing the workspace requires Node `>=22.11.0` and pnpm `>=10`. The published packages support
Node `>=20.11.0`.

## License

[MIT](./LICENSE)
