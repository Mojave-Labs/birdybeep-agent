# Installing BirdyBeep

This is the canonical walkthrough for getting BirdyBeep running in your coding harness: install the
CLI, pair your machine, install the agent adapters, and verify that events flow. The whole thing
takes a couple of minutes, and every step is reversible.

BirdyBeep is open source (MIT) and auditable on purpose — this code runs in your dev environment, so
you can read exactly what it does. The short version of the trust story:

- **Installs are non-destructive.** Each adapter adds only BirdyBeep-managed entries to your existing
  config, backs up the original once before its first change, and is fully reversible.
- **Installs are idempotent.** Running install twice produces the same result — no duplicates.
- **Installs never write a token.** Your machine token lives in the OS keychain (or a
  strict-permission file), never in harness config and never in a repo file. The hook reads it at
  runtime.

---

## 1. Install the CLI

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

## 2. Pair your machine — `birdybeep login`

Pairing links this machine to your BirdyBeep account so events can be delivered to you.

```bash
birdybeep login
```

This uses a device-flow pairing handshake. The CLI prints a short link and a code, then waits:

```text
To pair this machine, open the link and confirm the code:
   Scan or open:  https://birdybeep.app/pair/…
   Code:  WXYZ-1234
Waiting for confirmation…
```

Open the link (or scan it from the mobile app), confirm the code, and the CLI finishes:

```text
✓ Paired as MacBook Pro. Run `birdybeep test` to send a test Beep.
```

What this does with your token:

- The pairing link carries only short-lived pairing info — **never a durable token**.
- On success, the issued machine token is written to the **OS keychain** if one is available, or
  otherwise to a **strict-permission (0600) file** in your user config directory.
- The token is **never** written into harness config or any repo file.
- The server stores only a **hash** of the token. The token is shown once and can be revoked or
  rotated at any time from the mobile app.

> Note: the pairing backend endpoints are provisional and may change. If `login` can't reach the
> backend yet, pair later — adapter installs don't require a token.

To unpair, run `birdybeep logout`, which removes the token from the keychain and the file fallback.
It's idempotent (safe to run when already logged out).

---

## 3. Install the agent adapters — `birdybeep agent install`

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
```

`all` is the default, so `birdybeep agent install` with no target is equivalent to
`birdybeep agent install all`.

The command detects each supported harness first and **skips any that aren't installed** — it won't
create config for a harness you don't use. Output looks like this:

```text
✓  Claude Code: installed (/Users/you/.claude/settings.json)
✓  Codex: needs_trust (/Users/you/.codex/config.toml)
     → Codex hooks installed.
     → Codex may require one-time hook trust. Open Codex and run /hooks.
     → After trust is granted, Codex sessions on this machine will be tracked automatically.
✓  OpenCode: needs_restart (/Users/you/.config/opencode/opencode.json)
     → BirdyBeep plugin added to OpenCode.
     → Restart OpenCode for the plugin to load.
     → After restart, OpenCode sessions on this machine will be tracked automatically.
```

Use `--json` for machine-readable output (changed files, backups, required actions, and per-harness
status).

### What each install writes

Every install backs up the original file once (a `.birdybeep-backup` sibling) before its first
change, adds only BirdyBeep-managed entries, and writes no token.

#### Claude Code

- **File:** `~/.claude/settings.json`
- **Change:** appends a BirdyBeep-managed entry to the relevant lifecycle hooks (`SessionStart`,
  `Notification`, `PermissionRequest`, `Stop`, `StopFailure`, `SubagentStop`). Each entry runs
  `birdybeep hook claude` with a short timeout. Your own hooks are preserved.
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
- **Change:** sets the top-level `notify` program to `["birdybeep", "hook", "codex"]` (fires on
  turn-complete) and adds `[[hooks.X]]` lifecycle entries for `SessionStart`, `PermissionRequest`,
  `PostToolUse`, `SubagentStart`, and `SubagentStop`. Each hook runs `birdybeep hook codex`. Your
  own config is preserved.
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

---

## 4. Per-harness gotchas

Two harnesses need one extra action before they're live. The CLI surfaces this for you, both in the
install output and in `birdybeep status` / `birdybeep doctor`.

### Codex needs one-time hook trust → `needs_trust`

Codex skips hooks it hasn't trusted, so a fresh install reports `needs_trust`. To grant trust:

1. Open Codex.
2. Run `/hooks`.

(The top-level `notify` program is not trust-gated, so turn-complete Beeps can arrive before trust;
the lifecycle hooks need the trust step.) Codex isn't marked fully installed until the first real
event arrives, which proves trust was granted — until then its status stays `needs_trust`.

### OpenCode needs a restart → `needs_restart`

OpenCode loads plugins only at startup, so a fresh install reports `needs_restart`. **Restart
OpenCode** and the plugin loads. Status stays `needs_restart` until the first event after the
restart confirms the plugin is live.

---

## 5. Verify it works — `birdybeep status` and `birdybeep test`

Check the overall state:

```bash
birdybeep status
```

```text
Machine: MacBook Pro (macos)
Login:   paired
Integrations:
  Claude Code: installed
  Codex: needs_trust
  OpenCode: needs_restart
Queue:   0 queued → 0 delivered, 0 remaining
```

`status` shows your machine identity, login state, per-harness integration status, and the local
queue depth. It opportunistically drains any queued events while it runs, and exits non-zero if
you're not logged in (handy for scripts). Add `--json` for the machine-readable form.

Send a real test event end-to-end:

```bash
birdybeep test
```

This pushes a test event through the actual sender path and reports whether it was delivered or
queued for retry. If everything is paired and reachable, you should get a Beep on your phone.

For a deeper diagnosis, run:

```bash
birdybeep doctor
```

`doctor` checks your token, each adapter (including `needs_trust` / `needs_restart` / error states),
the local queue, and backend reachability — printing a specific fix for each failure. It drains the
queue as it goes and exits non-zero if anything is wrong.

---

## 6. Uninstalling — `birdybeep agent uninstall`

Uninstall is the exact inverse of install: it removes only BirdyBeep-managed entries and restores
your config from the backup.

```bash
birdybeep agent uninstall all
```

Or per harness:

```bash
birdybeep agent uninstall claude
birdybeep agent uninstall codex
birdybeep agent uninstall opencode
```

Uninstall is safe and idempotent — running it when nothing is installed is a no-op:

```text
✓  Claude Code: removed (/Users/you/.claude/settings.json)
–  Codex: nothing to remove
```

To fully unpair the machine afterward, run `birdybeep logout` to delete the stored token.

---

## What gets sent (the privacy summary)

Before anything leaves your machine, the hook sanitizes the payload:

- **Absolute paths are hashed** (including the working directory) — they're sent as `h_<hex>`, never
  as readable paths.
- **Secret-shaped strings are redacted** (`[redacted]`) — AWS/GitHub/OpenAI/Slack keys, JWTs, and
  `key=value` secrets.
- **Strings are truncated** (title ~200, body ~2000, metadata values ~500 chars) under a 16 KB total
  cap.
- The adapters deliberately do **not** forward raw user or assistant content — only safe
  discriminators like a tool name or status flow through.

The hook always returns fast and never blocks your harness. If a send fails, the event goes to a
best-effort local retry queue (24h retention, strict permissions) that's drained opportunistically
on the next hook, `status`, or `doctor`. On the backend, notification title and body are not
persisted by default — only metadata, hashes, and delivery/session status.

For the full detail, see [`docs/SPEC.md`](./SPEC.md) (§6, §7, §11) and the adapter source under
`packages/claude-code`, `packages/codex`, and `packages/opencode`.
