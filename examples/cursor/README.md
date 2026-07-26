# Example — Cursor

This is the **exact** config `birdybeep agent install cursor` writes into your Cursor hooks file at
`~/.cursor/hooks.json`. It is the same artifact the adapter's snapshot tests assert against — and a
drift guard re-runs the real installer in CI and compares it to this file byte for byte — so what you
see here is what the installer produces.

[`hooks.json`](./hooks.json) shows the **from-scratch** case: a brand-new hooks file with nothing in
it but BirdyBeep's entries. If you already have a `hooks.json`, the installer merges these entries in
and leaves everything else untouched (see "Non-destructive" below).

## What BirdyBeep adds

Cursor's hooks file is `{ "version": 1, "hooks": { "<event>": [ { command, timeout } ] } }`, and each
hook command receives the event payload as JSON on **stdin**. BirdyBeep registers one managed entry
per event it can consume:

| Hook event             | Beep it produces                                                        |
| ---------------------- | ----------------------------------------------------------------------- |
| `sessionStart`         | a session began on this machine                                         |
| `sessionEnd`           | the agent finished (`final_status: "completed"`), else the session ends |
| `beforeShellExecution` | a shell command is waiting on your approval                             |
| `preToolUse`           | a tool started                                                          |
| `postToolUse`          | a tool finished                                                         |
| `stop`                 | the agent finished its turn (IDE)                                       |
| `subagentStart`        | a subagent started                                                      |
| `subagentStop`         | a subagent finished                                                     |

Three further events — `beforeSubmitPrompt`, `postToolUseFailure`, and `afterAgentResponse` — are
registered too but have no BirdyBeep event to map to today, so the hook simply returns `skipped`.
They are registered anyway so a future mapping needs no re-install.

Every entry is identical in shape:

```json
{
  "command": "birdybeep hook cursor",
  "timeout": 30
}
```

The `timeout: 30` (seconds) is a hard cap so a slow or offline send can never hang Cursor — the hook
always returns fast and queues locally if the network is down.

> **CLI vs. IDE.** Headless `cursor-agent -p` fires only `sessionStart` and `sessionEnd`, so for CLI
> users a completed `sessionEnd` is the "your agent finished" Beep. In the IDE you additionally get
> `stop`, tool events, and the shell-approval gate.

## What you keep

Everything else. The installer touches exactly two things: the `hooks` key (and within it only
the events above), and the top-level `"version": 1` scaffold Cursor requires — added ONLY when
the key is absent, so an existing value of your own is preserved byte-for-byte. If you already have a
hook on one of these events, BirdyBeep's entry is **appended** to that event's list; your hook is
never replaced. The original file is backed up once to `~/.cursor/hooks.json.birdybeep-backup`
before the first change.

## No token here

There is **no token in this file**, and there never will be. `birdybeep hook cursor` reads your
machine token from the OS keychain (or a strict-permission file) at event time. Tokens are never
written into harness config or any repo file. See [`docs/security.md`](../../docs/security.md).

## Privacy note specific to Cursor

Cursor's hook payloads carry two things BirdyBeep deliberately drops: `user_email` (your account
address) and `transcript_path` (a local filesystem path). Neither is ever copied into the event —
not the title, body, metadata, session id, or workspace. The only path touched is
`workspace_roots[0]`, which is **hashed** like every other path.

## Reversible

`birdybeep agent uninstall cursor` removes exactly these BirdyBeep-managed entries and restores the
original file. Installs are idempotent — running install twice produces this same result, with no
duplicate hooks.

## When it takes effect

Immediately. Cursor reads `hooks.json` live, so there is no restart or trust step — unlike Codex
(`needs_trust`) and OpenCode (`needs_restart`), Cursor reports `installed` right away.

## Learn more

- [`docs/install.md`](../../docs/install.md) — install / uninstall flow
- [`docs/security.md`](../../docs/security.md) — token storage and exactly what data leaves the machine
