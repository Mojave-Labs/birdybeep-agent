# Example — Codex

This is the **exact** config `birdybeep agent install codex` writes into your Codex config at
`~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). It is the same artifact the adapter's snapshot
tests assert against — not a hand-written approximation — so what you see here is what the installer
produces.

[`config.toml`](./config.toml) shows the **from-scratch** case: a brand-new config with nothing but
BirdyBeep's `notify` program and lifecycle hooks. If you already have a `config.toml`, the installer
merges these entries in and leaves everything else untouched (see "Non-destructive" below).

## What BirdyBeep adds

Codex can invoke an external program two ways, and BirdyBeep uses both so every relevant moment is
covered:

1. **The top-level `notify` program** — fires on turn completion (`agent-turn-complete`). Codex
   appends the event JSON as the final argument:

   ```toml
   notify = [ "birdybeep", "hook", "codex" ]
   ```

2. **Lifecycle `[[hooks.X]]` entries** — one per event BirdyBeep consumes, each running
   `birdybeep hook codex`:

   | Hook event          | Why BirdyBeep listens                      |
   | ------------------- | ------------------------------------------ |
   | `SessionStart`      | a session began on this machine            |
   | `PermissionRequest` | a tool/command is waiting on your approval |
   | `PostToolUse`       | a tool finished running                    |
   | `SubagentStart`     | a subagent started                         |
   | `SubagentStop`      | a subagent finished                        |

Each hook entry looks like this:

```toml
[[hooks.SessionStart]]
matcher = ""

[[hooks.SessionStart.hooks]]
type = "command"
command = "birdybeep hook codex"
timeout = 10
```

> There is intentionally **no `Stop` hook**. The `notify` program already signals turn completion,
> so registering both would double-fire. The `timeout = 10` (seconds) is a hard cap so a slow or
> offline send can never hang Codex.

## What you keep

Everything else. The installer only sets `notify` and adds the five `[[hooks.X]]` events above. Other
keys — `model`, `approval_policy`, `[tui]`, `[sandbox]`, your own hooks — are preserved exactly. If
you already have a hook on one of these events, BirdyBeep's entry is **appended** to that event; your
hook is never replaced. (The one exception: a single-valued `notify` is replaced with the managed
array — and uninstall restores it.) The original file is backed up once to
`~/.codex/config.toml.birdybeep-backup` before the first change.

## One-time trust (important)

Codex skips hooks it does not trust, so after install BirdyBeep reports **`needs_trust`**. To finish:

> **Open Codex and run `/hooks`** to trust the hooks. After trust is granted, Codex sessions on this
> machine are tracked automatically — the integration goes live on the first trusted lifecycle hook
> (a turn-complete beep via the ungated `notify` program does not count as proof of trust).

## No token here

There is **no token in this file**, and there never will be. `birdybeep hook codex` reads your
machine token from the OS keychain (or a strict-permission file) at event time. Tokens are never
written into harness config or any repo file. See [`docs/security.md`](../../docs/security.md).

## Reversible

`birdybeep agent uninstall codex` removes exactly these BirdyBeep-managed entries and restores the
original config. Installs are idempotent — running install twice produces this same result, with no
duplicate hooks.

## Learn more

- [`docs/install.md`](../../docs/install.md) — install / uninstall flow and the `/hooks` trust step
- [`docs/security.md`](../../docs/security.md) — token storage and exactly what data leaves the machine
