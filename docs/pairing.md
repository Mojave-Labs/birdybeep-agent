# Pairing

`birdybeep pair` connects this machine to your BirdyBeep account. After pairing, it installs adapters for detected coding agents and sends a test notification. `birdybeep setup` uses the same flow but skips pairing when a machine token already exists.

The QR and complete link contain a short-lived approval secret. The machine token is returned only after approval.

## Pair a machine

1. Run `birdybeep pair`.
2. Scan the QR or open the complete link.
3. Approve the machine in BirdyBeep.
4. Confirm the approving account in the terminal.

```text
To pair this machine, open the BirdyBeep app, tap “pair a machine”, and scan this QR or open the complete link:
   ▄▄▄▄▄▄▄ ▄  ▄▄ ▄▄▄▄▄▄▄
   Scan or open:  https://birdybeep.com/pair#code=WXYZ-1234&s=<short-lived-approval-secret>
   Session code (display only; cannot approve by itself):  WXYZ-1234
Waiting for approval in the BirdyBeep app.
Pair this machine to you@example.com? [y/N] y
✓ Paired to you@example.com.
```

The command then installs detected adapters, prints a coverage table, and sends a test Beep. Pass `--no-install` to stop after storing the machine token or `--no-test` to skip the test.

If the pairing session expires, run `birdybeep pair` again for a new QR and link.

## QR, links, and remote machines

The QR and printed link contain the same approval secret. The displayed session code identifies the request but cannot approve it.

On a remote machine, copy the complete link, including everything after `#`, and open it on a device signed in to BirdyBeep. The remote machine does not need a browser or camera.

When terminal output is piped, the CLI omits the QR matrix and prints the complete link and session code.

## Confirm the approving account

Before storing the machine token, the CLI displays the account that approved the request. Declining stores no token or configuration. The server-side machine created by the approval remains until you revoke it in the app.

Only `y` or `yes`, in any letter case, accepts the account. Empty input, `n`, EOF, and `Ctrl-D` decline.

For unattended pairing, `--expect-email <addr>` requires an exact account match. `--yes` accepts whichever account approved the request.

```bash
birdybeep pair --expect-email you@example.com
birdybeep pair --yes
```

An expected email mismatch stores no token. A response without an approving email also fails when `--expect-email` is set. `--yes` does not override an email mismatch.

### Terminal behavior

The prompt is written to stderr. The answer is read from stdin when stdin is a terminal. On macOS and Linux, the CLI otherwise tries the controlling terminal at `/dev/tty`.

Windows has no controlling-terminal fallback. PowerShell, `cmd`, Windows Terminal, and the VS Code terminal provide a usable terminal. In Git Bash, MSYS, or mintty, run:

```bash
winpty birdybeep pair
```

If no terminal is available, use `--expect-email` or `--yes`. `--non-interactive` always requires one of those flags.

## JSON and non-interactive output

`birdybeep pair --json` emits newline-delimited JSON. The first object contains the complete `qr_payload`; the last parseable object contains the result.

```json
{ "status": "pairing_started", "user_code": "WXYZ-1234", "qr_payload": "https://birdybeep.com/pair#code=WXYZ-1234&s=<short-lived-approval-secret>", "expires_at": "2026-07-01T12:34:56.000Z" }
{ "paired": true, "machineId": "mac_123", "approvedByEmail": "you@example.com" }
```

For unattended use:

```bash
birdybeep pair --json --expect-email you@example.com
```

Failure results include `timeout`, `declined`, `non_interactive`, `expected_email_mismatch`, `expected_email_unverifiable`, or a backend error code such as `quota_exceeded`.

## Pairing security

| Item                    | Behavior                                                  |
| ----------------------- | --------------------------------------------------------- |
| QR or complete link     | Contains a short-lived, single-use approval secret        |
| Displayed session code  | Identifies the request but cannot approve it              |
| Machine token           | Minted after approval and returned once                   |
| Approving-account check | Runs before the token is stored                           |
| Server storage          | Stores a hash of the machine token                        |
| Revocation              | Available through `birdybeep unpair` or the BirdyBeep app |

## Token storage

The CLI stores the machine token in the OS keychain when available. Otherwise, it uses a `0600` file inside a `0700` directory under the user data directory.

Harness configuration contains no machine token. Re-pairing replaces the stored token. See [Security and privacy](./security.md) for storage details.

## Unpair and logout

`birdybeep unpair` revokes the machine on the server and deletes its local token.

`birdybeep logout` deletes only the local token. The machine remains listed in your BirdyBeep account.

If `unpair` cannot reach the server, it still deletes the local token and tells you to revoke the machine in the app.

Neither command removes installed adapters or clears the local event queue. Use `birdybeep agent uninstall` to remove adapters.

For expired links, terminal-confirmation errors, wrong-account approvals, or missing notifications, see [Troubleshooting](./troubleshooting.md).
