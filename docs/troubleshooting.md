# Troubleshooting

Run `birdybeep doctor` first. It checks pairing, detected adapters, the local queue, device reachability, quota, and backend reachability. Failed checks include a command or action to try.

```bash
birdybeep doctor
birdybeep doctor --json
```

Installation steps are in [`install.md`](install.md); data and token handling are in [`security.md`](security.md).

## Diagnostic output

| Marker | Meaning                         |
| ------ | ------------------------------- |
| `✓`    | check passed                    |
| `✗`    | check failed                    |
| `!`    | action or information available |

`doctor` exits with status 1 when a required check fails. `--json` returns the same checks without terminal formatting.

## Adapter status

### Integration reports `not_detected`

The coding agent is not installed in a location BirdyBeep can detect. Install it, start it once if it creates configuration on first run, then run:

```bash
birdybeep agent install <harness>
birdybeep doctor
```

Supported targets are `claude`, `codex`, `opencode`, `cursor`, and `copilot`.

### Codex reports `needs_trust`

Open Codex and run `/hooks`. Status changes to `installed` after the next trusted lifecycle event reaches BirdyBeep.

If status remains `needs_trust`, trigger a Codex lifecycle event and run `birdybeep doctor` again. A top-level `notify` event does not prove lifecycle-hook trust.

### OpenCode reports `needs_restart`

Restart every running OpenCode process, trigger an event, then run `birdybeep doctor` again. Status changes after the restarted plugin emits an event.

### Integration reports `unknown`

The harness is present but its BirdyBeep entries are missing. Run:

```bash
birdybeep agent install <harness>
```

Repeated installation does not add duplicate entries.

### Integration reports `error`

The diagnostic detail identifies the configuration problem.

Malformed JSON or TOML:

1. Repair the file shown by `doctor`, or remove it if it contains nothing you need.
2. If `doctor` reports a `.birdybeep-backup`, restore that file instead.
3. Run `birdybeep agent install <harness>`.

BirdyBeep does not modify a configuration file it cannot parse.

Partial installation:

```bash
birdybeep agent install <harness>
```

The installer restores missing BirdyBeep-owned entries while preserving other configuration.

Stale hook command:

```bash
birdybeep agent install <harness>
```

Run this after moving the CLI or changing Node versions. It replaces the managed hook command with the current executable path.

Read-only configuration: change the file or directory permissions reported by `doctor`, then run the installation command again.

## Pairing

### Pairing cannot ask for confirmation

For CI or scripts, require the expected account:

```bash
birdybeep pair --expect-email you@example.com
```

Use `birdybeep pair --yes` only when accepting any approving account is intended.

PowerShell, `cmd`, Windows Terminal, and the VS Code terminal provide a usable Windows terminal. In Git Bash, MSYS, or mintty, run:

```bash
winpty birdybeep pair
```

`--non-interactive` always requires `--expect-email` or `--yes`.

### Machine is not paired

```bash
birdybeep pair
```

Expired and previously used pairing links cannot be reused. Run the command again for a new QR and link.

If the machine was revoked in the app, its stored token no longer works. Pair again. To remove only the stale local token first:

```bash
birdybeep logout
```

To revoke the server record and delete the local token together, use `birdybeep unpair`.

### Pairing was approved by the wrong account

The CLI stores no token when `--expect-email` does not match the approving account. Revoke the server-side machine in the app, then start a new pairing request.

## Token and delivery

### Token storage is unreadable and pairing is `unknown`

Queued events remain local while token storage is unavailable. Restore access, then run `birdybeep doctor` to drain the queue.

On macOS, unlock the login keychain by signing in to or unlocking the desktop session.

On Linux, Windows, and headless systems, repair the fallback path reported by `doctor`:

```bash
chmod 700 "$(dirname <path>)"
chmod 600 <path>
birdybeep doctor
```

If storage remains unreadable, run `birdybeep pair` to store a new token.

### Backend is unreachable

Check the connection, VPN, or proxy. Retryable events remain in the local queue. Run `birdybeep doctor` or `birdybeep status` after connectivity returns.

### Events are queued

Queued events remain local while delivery is unavailable. Restore network or token-store access, then run `birdybeep doctor` to drain the queue.

The queue also drains on the next harness event or `birdybeep status`. Events expire after 24 hours. To delete all queued events without delivering them:

```bash
birdybeep queue clear
```

### A test event was delivered but no notification arrived

Run:

```bash
birdybeep test
```

If the test reports delivery but no notification appears, check notification permission, machine and integration mutes, and the app's push status. The event reached the backend, so the remaining path is downstream of this CLI.

### Cursor events arrive through Claude Code hooks

Cursor desktop may read `~/.claude/settings.json` and invoke `birdybeep hook claude` with a Cursor payload. BirdyBeep routes that payload to the Cursor adapter.

This bridge does not provide Cursor approval events. Install Cursor's hooks directly:

```bash
birdybeep agent install cursor
```

Both integrations can remain installed. Duplicate events are collapsed.

## Hook errors

`birdybeep hook <harness>` exits non-zero when it cannot accept or preserve an event. The harness hook log contains the diagnostic.

| Diagnostic                                                | Action                                         |
| --------------------------------------------------------- | ---------------------------------------------- |
| `… is not a <harness> hook event`                         | Check which tool invokes the configured hook.  |
| `the payload was empty`                                   | Check whether the harness supplied stdin.      |
| `the N-byte payload is not valid JSON`                    | Check the program writing to the hook's stdin. |
| `timed out after 3000ms waiting for the payload on stdin` | Retry and run `birdybeep doctor`.              |
| `second argument must be a Copilot hook event name`       | Run `birdybeep agent install copilot`.         |

Supported but locally filtered event types exit successfully without sending anything.

## Report an unresolved problem

If `birdybeep doctor --json` does not identify the problem, attach its output to a GitHub issue. The output excludes machine tokens and notification contents.
