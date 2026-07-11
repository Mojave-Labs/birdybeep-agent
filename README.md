# BirdyBeep

**Mobile notifications for your AI coding agent.** When Claude Code, Codex, or OpenCode needs
you — an approval, some input, a finished run, an idle session, a failure — BirdyBeep sends a
push to your phone so you can walk away from the terminal and still know the moment your agent
is waiting on you.

This repository is the **public, [MIT-licensed](./LICENSE), auditable** half of BirdyBeep: the
open-source CLI (`@birdybeep/cli`) and the per-harness adapters that run inside your coding
agent. This code installs into your dev environment and watches your agents, so it is open on
purpose — you can read exactly what it touches and exactly what leaves your machine. The mobile
app and backend live in a separate private repo.

---

## How it works

You install BirdyBeep once per machine and pair it with the mobile app. From then on, each
supported agent emits lifecycle events (session started, approval required, completed, failed,
and so on) through a small local hook:

```text
Harness hook/plugin
  → birdybeep hook <harness>     # reads the machine token, normalizes the event
    → redacts secrets, hashes absolute paths, truncates long fields
    → sends to the BirdyBeep API with a short timeout
    → queues locally on failure, then returns fast
```

There is **no background daemon**. The hook runs only when your agent fires an event, does its
work in a few milliseconds, and gets out of the way. If delivery fails (you're offline), the
event lands in a small local retry queue and is sent later — it never blocks or slows your
harness.

## What it touches on your machine

BirdyBeep is deliberately small-footprint and reversible. It only ever touches:

- **Per-harness config in your home directory** — e.g. `~/.claude/settings.json`,
  `~/.codex/config.toml`, `~/.config/opencode/opencode.json`. Installs are idempotent, back up
  the original once, and add **only** BirdyBeep-managed entries. (See [Per-harness
  details](#per-harness-details).)
- **A local event queue** — best-effort, ~24h retention, strict file permissions. It exists
  only to retry events that couldn't be delivered immediately. It is **not** a durable audit
  log, and you can clear it any time.
- **One machine token** — stored in your **OS keychain** when available, otherwise a
  strict-permission (`0600`) file in your user config directory. The token is **never** written
  into harness config or any repo file.

## Install

Install the CLI, pair the machine, then wire up your agents.

```bash
npm install -g @birdybeep/cli   # or pnpm add -g / yarn global add

birdybeep pair                 # device-flow pairing: prints a short URL + code, polls until paired
birdybeep agent install all     # detect installed agents and wire them up (or: claude | codex | opencode)
birdybeep status                # confirm machine, pairing, and per-harness integration state
```

`agent install` is **idempotent** — re-running it produces the same result. It backs up any
existing config, adds only BirdyBeep-managed entries, prints the files it changed and any action
you still need to take, and installs at the **user/global** level. It never writes a token into
config.

Some harnesses need one extra step after install — see [Per-harness details](#per-harness-details).

## Uninstall (fully reversible)

```bash
birdybeep agent uninstall all   # or: claude | codex | opencode
birdybeep logout                # remove the machine token (idempotent)
```

Uninstall removes **only** BirdyBeep-managed entries and restores your config from the backup,
so your settings come back exactly as they were. `logout` clears the local token from both the
keychain and the file fallback.

## Commands

The CLI surface (run `birdybeep <command> --help` for per-command help):

| Command                                                    | What it does                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `birdybeep pair`                                           | Device-flow pairing — prints a short URL + code, polls until paired, stores the machine token in the secure store.                                                                    |
| `birdybeep logout`                                         | Removes the machine token (keychain + file fallback). Idempotent. Same as `unpair`.                                                                                                   |
| `birdybeep unpair`                                         | Unpairs this machine — removes the machine token (keychain + file fallback). Idempotent. Same as `logout`.                                                                            |
| `birdybeep status`                                         | Machine + pairing state, per-harness integration status, and queue depth. Drains the queue opportunistically; exits non-zero if not paired.                                           |
| `birdybeep test`                                           | Sends a test event through the real sender path and reports whether it was delivered or queued.                                                                                       |
| `birdybeep doctor`                                         | Checks the token, each adapter (`needs_trust` / `needs_restart` / `error`), the queue, and backend reachability; prints a fix per failure; drains the queue; non-zero on any failure. |
| `birdybeep agent install [all\|claude\|codex\|opencode]`   | Detect + install per harness (idempotent, backs up, managed entries only, no token).                                                                                                  |
| `birdybeep agent uninstall [all\|claude\|codex\|opencode]` | Remove only managed entries and restore from backup (reversible).                                                                                                                     |
| `birdybeep queue clear`                                    | Drop all locally-queued events (debug).                                                                                                                                               |

Two internal commands are invoked by BirdyBeep itself, not by you:

- `birdybeep hook <claude\|codex\|opencode>` — the hook the installed harness config calls. It
  reads the event payload, normalizes and redacts it, sends with a short timeout, queues on
  failure, and **always returns fast and exits 0**.
- `birdybeep report-status` — posts each adapter's pre-event integration status to the backend.

### Global flags & exit codes

Available on the root command and per command:

| Flag                | Effect                                        |
| ------------------- | --------------------------------------------- |
| `--json`            | Machine-readable JSON output.                 |
| `--non-interactive` | Never prompt; fail fast if input is required. |
| `-h`, `--help`      | Show help (root or per-command).              |
| `-v`, `--version`   | Show the CLI version.                         |

Exit codes: **`0`** ok · **`1`** error · **`2`** usage.

## Per-harness details

All installs are idempotent, back up the original once, add only BirdyBeep-managed entries, and
write no token.

- **Claude Code** — patches the hooks in `~/.claude/settings.json` to invoke
  `birdybeep hook claude`. Claude Code reads its config live, so the integration is **active
  immediately** — no restart needed.
- **Codex** — patches `~/.codex/config.toml`: a top-level `notify` program plus `[[hooks.X]]`
  lifecycle hooks (SessionStart, PermissionRequest, PostToolUse, SubagentStart, SubagentStop),
  all invoking `birdybeep hook codex`. Codex requires a **one-time hook trust**: open Codex and
  run `/hooks`. Until the first real event proves trust was granted, status shows
  **`needs_trust`**.
- **OpenCode** — adds `@birdybeep/opencode` to the `plugin` array in
  `~/.config/opencode/opencode.json` (honors `XDG_CONFIG_HOME`). OpenCode loads plugins only at
  startup, so **restart OpenCode**. Until the first event after restart, status shows
  **`needs_restart`**.

`birdybeep status` and `birdybeep doctor` surface these states and tell you exactly what to do.

## Security & privacy

BirdyBeep is designed so that **as little as possible leaves your machine**, and what does is
scrubbed first. Before any event is sent, the local hook:

- **Hashes absolute paths** to opaque `h_<16-hex>` tokens (your `cwd` is always hashed).
- **Redacts secret-shaped strings** — AWS / GitHub / OpenAI / Slack keys, JWTs, and
  `key=value` secrets become `[redacted]`.
- **Truncates** long fields (title 200, body 2000, metadata-value 500 chars) under a 16 KB cap.
- **Drops raw user/assistant content by design** — Codex drops input messages, the last
  assistant message, and tool input; OpenCode drops tool args, permission titles, and error
  messages. Only safe discriminators (tool name, status) ever flow.

The canonical event carries an event id and type, timestamp, harness, session id, machine label

- OS, a hashed workspace, status, a short title/body, and optional metadata. The backend does
  **not** persist notification title/body by default — only metadata, hashes, and delivery +
  session status.

**Tokens** live in your OS keychain (or a strict-permission file fallback) and are never written
into harness config or any repo file. The server stores only token **hashes**; the token is
shown once and can be revoked or rotated from the mobile app.

Full details, including the exact redaction patterns and the wire schema, are in
[`docs/security.md`](./docs/security.md).

## Why you can trust it

This package edits real config in your home directory and hooks into your coding agents, so it
earns trust by being **open and auditable**:

- **MIT-licensed and public** — read every line that runs on your machine.
- **Reversible, non-destructive installs** — back up once, add only managed entries, restore
  byte-for-byte on uninstall.
- **No durable secrets in config or repos** — tokens stay in the keychain only.
- **Privacy enforced before delivery** — hashing, redaction, and truncation run locally, in
  this code, before anything is sent.

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

## Develop

```bash
pnpm install
pnpm build       # turbo run build — tsup ESM/CJS + d.ts per package
pnpm lint
pnpm typecheck
pnpm test
```

Requires Node `>=20.11.0` and pnpm `>=10`.

## License

[MIT](./LICENSE)
