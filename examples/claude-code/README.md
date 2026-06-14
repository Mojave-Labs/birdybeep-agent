# Example — Claude Code

This is the **exact** config `birdybeep agent install claude` writes into your Claude Code user
settings at `~/.claude/settings.json`. It is the same artifact the adapter's snapshot tests assert
against — not a hand-written approximation — so what you see here is what the installer produces.

[`settings.json`](./settings.json) shows the **from-scratch** case: a brand-new settings file with
nothing in it but BirdyBeep's hooks. If you already have a `settings.json`, the installer merges
these entries in and leaves everything else untouched (see "Non-destructive" below).

## What BirdyBeep adds

BirdyBeep registers a `command` hook on the Claude Code lifecycle events it consumes. Each one runs
`birdybeep hook claude`, which reads the event from Claude Code, normalizes and redacts it, and ships
a notification to your phone:

| Hook event          | Why BirdyBeep listens                      |
| ------------------- | ------------------------------------------ |
| `SessionStart`      | a session began on this machine            |
| `Notification`      | Claude Code surfaced a notification/prompt |
| `PermissionRequest` | a tool/command is waiting on your approval |
| `Stop`              | the agent finished its turn                |
| `StopFailure`       | the turn ended in failure                  |
| `SubagentStop`      | a subagent finished                        |

Every entry is identical in shape:

```json
{
  "matcher": "",
  "hooks": [
    {
      "type": "command",
      "command": "birdybeep hook claude",
      "timeout": 10
    }
  ]
}
```

The `timeout: 10` (seconds) is a hard cap so a slow or offline send can never hang Claude Code — the
hook always returns fast and queues locally if the network is down.

## What you keep

Everything else. The installer only touches the `hooks` key, and within it only the six events above.
Any other settings — `theme`, `mcpServers`, `permissions`, your own `Stop` hook — are preserved
exactly. If you already have a hook on one of these events, BirdyBeep's entry is **appended** to that
event's list; your hook is never replaced. The original file is backed up once to
`~/.claude/settings.json.birdybeep-backup` before the first change.

## No token here

There is **no token in this file**, and there never will be. `birdybeep hook claude` reads your
machine token from the OS keychain (or a strict-permission file) at event time. Tokens are never
written into harness config or any repo file. See [`docs/security.md`](../../docs/security.md).

## Reversible

`birdybeep agent uninstall claude` removes exactly these BirdyBeep-managed entries and restores the
original file. Installs are idempotent — running install twice produces this same result, with no
duplicate hooks.

## When it takes effect

Immediately. Claude Code reads `settings.json` live, so there is no restart or trust step — the next
event flows the moment install finishes.

## Learn more

- [`docs/install.md`](../../docs/install.md) — install / uninstall flow
- [`docs/security.md`](../../docs/security.md) — token storage and exactly what data leaves the machine
