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

## Supported harnesses

| Harness         | Target     | Status      | Config it patches                                              | Extra step              |
| --------------- | ---------- | ----------- | -------------------------------------------------------------- | ----------------------- |
| **Claude Code** | `claude`   | **shipped** | `~/.claude/settings.json`                                      | none — live immediately |
| **Codex**       | `codex`    | **shipped** | `~/.codex/config.toml` (honors `$CODEX_HOME`)                  | one-time `/hooks` trust |
| **OpenCode**    | `opencode` | **shipped** | `~/.config/opencode/opencode.json` (honors `$XDG_CONFIG_HOME`) | restart OpenCode once   |
| **Cursor**      | `cursor`   | **shipped** | `~/.cursor/hooks.json`                                         | none — live immediately |

Anything not in that table is not supported today — see
[Harness support & roadmap](#harness-support--roadmap) for what we looked at and why. Each harness's
exact generated config is committed under [`examples/`](../examples/README.md).

> **Versions this was verified against** (CLAUDE.md §21.1 — harness hook APIs move, so claims are
> pinned to what was actually exercised): **Cursor** `cursor-agent 2026.07.09` (headless `-p`,
> captured 2026-07-15 — see `packages/cursor/src/__fixtures__/README.md`). Claude Code, Codex, and
> OpenCode were verified live over 2026-07-14/15 against the versions then current. A newer harness
> release can change or add hook events; re-run the adapter's live E2E before trusting the table.

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

## 2. Pair your machine — `birdybeep pair`

Pairing links this machine to your BirdyBeep account so events can be delivered to you.

```bash
birdybeep pair
```

This uses a device-flow pairing handshake. The CLI prints a scannable QR (on a terminal), a short
link, and a code, then waits:

```text
To pair this machine, open the BirdyBeep app, tap “pair a machine”, and scan this QR (or enter the code):
   Scan or open:  https://birdybeep.com/pair#code=WXYZ-1234
   Code:  WXYZ-1234
Waiting for you to approve this machine in the app…
```

Approve it in the app, and the CLI asks you to confirm the account that approved it before it
trusts anything:

```text
Pair this machine to you@example.com? [y/N] y
✓ Paired to you@example.com. Run `birdybeep test` to send a test Beep.
```

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
     → Codex may require one-time hook trust. Open Codex and run /hooks.
     → After trust is granted, Codex sessions on this machine will be tracked automatically.
✓  OpenCode: needs_restart (/Users/you/.config/opencode/opencode.json)
     → BirdyBeep plugin added to OpenCode.
     → Restart OpenCode for the plugin to load.
     → After restart, OpenCode sessions on this machine will be tracked automatically.
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

#### Cursor

- **File:** `~/.cursor/hooks.json`
- **Change:** ensures the `"version": 1` scaffold Cursor requires (only if absent — an existing
  value is left alone) and appends a BirdyBeep-managed entry to each consumed hook event:
  `sessionStart`, `sessionEnd`, `beforeShellExecution`, `preToolUse`, `postToolUse`, `stop`,
  `subagentStart`, `subagentStop`, plus `beforeSubmitPrompt`, `postToolUseFailure`, and
  `afterAgentResponse` (registered for forward-compatibility; they have no mapping today and the
  hook returns `skipped`). Each entry runs `birdybeep hook cursor`. Your own hooks are preserved.
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
events, and the `beforeShellExecution` approval gate. Cursor's payloads include `user_email` and
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

## 4. Per-harness gotchas

Two of the five harnesses need one extra action before they're live (Claude Code, Cursor, and
GitHub Copilot CLI are live the moment install finishes). The CLI surfaces this for you, both in
the install output and in `birdybeep status` / `birdybeep doctor`.

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
Paired:  yes
Integrations:
  Claude Code: installed
  Codex: needs_trust
  OpenCode: needs_restart
  Cursor: installed
  GitHub Copilot CLI: installed
Queue:   0 queued → 0 delivered, 0 remaining
```

(When you aren't paired, the second line reads `` Paired:  no — run `birdybeep pair` `` and the
command exits 1.)

`status` shows your machine identity, pairing state, per-harness integration status, and the local
queue depth. It opportunistically drains any queued events while it runs, and exits non-zero if
you're not paired (handy for scripts). Add `--json` for the machine-readable form.

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

## 6. Staying up to date

You don't have to check for updates — the CLI does it for you. When you run any command, it prints a
one-line notice to **stderr** if a newer `@birdybeep/cli` has been published:

```text
a new version of birdybeep is available: 0.1.0 → 0.2.0
upgrade with: npm install -g @birdybeep/cli@latest
```

The notice is **non-intrusive by design**:

- **Cached.** The registry is checked at most once a day; every other run reads a small cache in your
  config dir, so there's no per-command network hit.
- **Never on the hot path.** The `hook` command (which runs inside your agent) is never delayed or
  touched by the check.
- **Quiet for scripts.** It's skipped under `--json`, `--non-interactive`, non-TTY output (pipes,
  logs), and `CI`. Turn it off entirely with `NO_UPDATE_NOTIFIER=1` (or
  `BIRDYBEEP_NO_UPDATE_NOTIFIER=1`). It respects a custom `npm_config_registry` if you have one set.
- **Advisory only.** It never touches your install — run the printed command (with whichever package
  manager you installed with) when you're ready.

Once you've upgraded, re-running `birdybeep agent install all` is safe (idempotent) and refreshes any
adapter config that changed between versions.

---

## 7. Uninstalling — `birdybeep agent uninstall`

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
birdybeep agent uninstall cursor
birdybeep agent uninstall copilot
```

Uninstall is safe and idempotent — running it when nothing is installed is a no-op:

```text
✓  Claude Code: removed (/Users/you/.claude/settings.json)
–  Codex: nothing to remove
```

To fully unpair the machine afterward, run `birdybeep logout` to delete the stored token.

---

## Harness support & roadmap

Adapters are cheap to write and expensive to keep honest: each one has to be verified against the
real harness end-to-end, and harness hook APIs move. So we ship an adapter only for harnesses we can
actually exercise, and we say plainly what we skipped.

**Shipped today:** Claude Code, Codex, OpenCode, Cursor, and GitHub Copilot CLI (the table at the
[top of this page](#supported-harnesses)).

### Looked at and not shipped

A landscape survey (snapshot: **2026-07-15**) ruled these out. Nothing here is a judgement of the
tools — it's about whether an adapter would have users and a stable hook surface to bind to:

| Harness        | Why there's no adapter                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------- |
| **Windsurf**   | Folded into Devin; no separately supported agent CLI to hook.                                     |
| **Roo Code**   | Discontinued (2026-05-15).                                                                        |
| **Continue**   | Acquired by Cursor (2026-06-16); the Cursor adapter is the successor path.                        |
| **Gemini CLI** | Individual access cut off (2026-06-18), folded toward Antigravity — no stable individual surface. |

Harness landscapes move fast, and this list is a snapshot, not a standing verdict. If one of these
comes back with a real hook API — or you want a harness that isn't listed at all — open an issue.

### Tier 2 — what a new adapter needs

The bar for any additional harness, in order:

1. **A real lifecycle hook surface** — the harness must be able to invoke an external command (or
   load a plugin) on session/approval/completion events. Polling and log-scraping are not adapters.
2. **A payload with safe discriminators** — enough to map to a [§10.1](./SPEC.md) event type without
   forwarding user or assistant content.
3. **A reproducible install** — a documented user-level config file we can patch non-destructively,
   back up, and fully restore on uninstall.
4. **End-to-end verification** — the adapter is not "supported" until a real event, fired by the
   real harness, is observed arriving at the backend. See
   [`docs/adapter-development.md`](./adapter-development.md).

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
`packages/claude-code`, `packages/codex`, `packages/opencode`, `packages/cursor`, and
`packages/copilot`.
