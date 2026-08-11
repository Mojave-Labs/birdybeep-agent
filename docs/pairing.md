# Pairing

`birdybeep pair` pairs this machine with your BirdyBeep account so the agent adapters can send
you Beeps (notifications). Pairing uses a device-authorization-style flow: the CLI shows you a QR,
its complete link, and a display-only session code; you confirm in the BirdyBeep mobile app, and
the CLI receives and stores a machine token locally.

The important part of the trust story up front: **the complete QR/link carries a short-lived,
high-entropy approval secret — never a durable token.** The displayed session code identifies the
pending request but cannot approve it by itself. The machine token is minted server-side, returned
to the CLI once, and stored locally in your OS keychain (or a strict-permission file). See
[Security](./security.md) for the full token-handling details.

> **Wire contract.** The pairing endpoints (`POST /v1/pair/start`, `POST /v1/pair/token`) are a
> cross-repo contract owned by the BirdyBeep product backend; the request/response schemas are
> mirrored field-for-field in `agent-core` (kept in lockstep with the product's `packages/schemas`).
> The CLI reads responses tolerantly. The handshake is exercised live against the real product
> worker by [`scripts/live-e2e-pair-confirm.mjs`](../scripts/live-e2e-pair-confirm.mjs) (real CLI
> binary, real `/v1/pair/start` → `/v1/pair/approve` → `/v1/pair/token`).

---

## Quick start

```bash
birdybeep pair
```

You'll see a QR code, its complete link, and a display-only session code. Scan the QR or open the
complete link, approve in the BirdyBeep app, then **confirm the account it was approved by** — the
CLI asks before it trusts anything:

```text
To pair this machine, open the BirdyBeep app, tap “pair a machine”, and scan this QR or open the complete link:
   ▄▄▄▄▄▄▄ ▄  ▄▄ ▄▄▄▄▄▄▄        (a scannable QR matrix renders here on a TTY)
   Scan or open:  https://birdybeep.com/pair#code=WXYZ-1234&s=<short-lived-approval-secret>
   Session code (display only; cannot approve by itself):  WXYZ-1234
Waiting for you to approve this machine in the app…
Pair this machine to you@example.com? [y/N] y
✓ Paired to you@example.com. Run `birdybeep test` to send a test Beep.
```

Answer `n` (or anything that isn't `y`/`yes`) and **no token is stored** — see
[Confirming the approving account](#confirming-the-approving-account) below, including the
`--yes` / `--expect-email` flags for headless machines.

`birdybeep pair` derives this machine's label from your hostname/OS and sends it when it opens
the session (editable later in the app). Once paired, run [`birdybeep test`](./install.md) to send
a test Beep, or `birdybeep status` to check integration state.

---

## How the device flow works

1. **Start.** `birdybeep pair` calls `POST /v1/pair/start` with this machine's label (derived from
   your hostname/OS), its OS, and the CLI version. The backend returns a **device code**, a
   display **user code**, a **QR payload** (which carries the code plus a high-entropy approval
   secret in its URL fragment), and an **`expires_at`** for the pairing session.
2. **Confirm.** You scan the QR or open the complete link in the BirdyBeep mobile app. The app
   submits both the display code and approval secret, then shows an approval screen for this
   machine. The display code alone is deliberately insufficient.
3. **Poll.** Meanwhile the CLI polls `POST /v1/pair/token` with the device code (and a stable,
   non-reversible machine fingerprint). Until you approve, the backend replies with a
   `validation_failed`/4xx, which the CLI treats as "not yet — keep polling".
4. **Mint.** When you approve, the backend mints a **machine token** server-side and the next poll
   returns `201 { machine_token, machine_id, approved_by_email }`.
5. **Confirm.** The CLI shows you the account that approved the machine and asks
   `Pair this machine to <email>? [y/N]`. Nothing is stored until you answer — see
   [Confirming the approving account](#confirming-the-approving-account).
6. **Store.** Once confirmed, the CLI writes the machine token to the secure token store
   (keychain, else a strict-permission file) and saves the non-secret API URL to its config. The
   token is **never** written into a repo file or any harness config.

If you don't confirm before the pairing session expires, the CLI stops polling and tells you to
retry:

```text
Pairing timed out before you approved it. In the BirdyBeep app, tap “pair a machine”, scan a fresh
QR or open its complete link, then run `birdybeep pair` again.
```

The pairing session is short-lived (the backend sets `expires_at` — a ~10-minute window), the
approval proof is single-use, and the device code only lets the CLI ask "am I approved yet?" — it
is **not** the machine token.

---

## QR and complete link

The pair URL is QR-friendly and opens on your phone with one tap. **Both supported paths are
equivalent**: scan the QR or open the complete link. Each carries the same short-lived approval
secret in the URL fragment. The displayed session code is useful for matching the terminal to the
approval sheet, but code-only approval is intentionally unavailable.

On an interactive terminal the CLI renders the pair URL as a scannable QR matrix (point the
BirdyBeep app's pairing camera at it), with the complete link and display code printed underneath.
When output is piped (CI logs, scripts) the matrix is skipped and only the plain lines print. So
in practice you'll either:

- **scan the QR** with the pairing screen's camera in the BirdyBeep app,
- **open the complete link** on a device where you're signed in to the BirdyBeep app.

Both paths submit the same single-use approval proof.

### Headless and SSH machines

Many agent boxes are remote — a CI runner, a cloud dev box, a server you reach over SSH. There's no
browser or camera there, and that's fine: pairing never needs one. The CLI prints the complete pair
URL as plain text, so you:

1. Run `birdybeep pair` on the remote machine.
2. Copy the complete link from the terminal, including everything after `#`.
3. Open the link on **any** device where you're signed in to BirdyBeep — your phone or a laptop.
4. Confirm. The remote CLI's next poll picks up the approval and stores the token there.

Because the confirmation happens on a device of your choosing and the link carries only a
short-lived approval proof, you can pair a headless box without exposing a browser or durable token
on it.

### Non-interactive mode

`birdybeep pair` works with the global `--non-interactive` flag (never prompts, fails fast) and
`--json` (machine-readable output). In `--json` mode the output is NDJSON — one JSON object per
line. The first line is emitted as soon as the pairing session opens. Your script or agent must
surface the complete `qr_payload` for approval; `user_code` is display-only identification. The
last line is the success result:

```json
{ "status": "pairing_started", "user_code": "WXYZ-1234", "qr_payload": "https://birdybeep.com/pair#code=WXYZ-1234&s=<short-lived-approval-secret>", "expires_at": "2026-07-01T12:34:56.000Z" }
{ "paired": true, "machineId": "mac_123", "approvedByEmail": "you@example.com" }
```

A non-interactive run still has to clear the confirmation gate, so pass `--expect-email <addr>`
(preferred) or `--yes` — without one of them the run **fails closed** rather than hanging:

```bash
birdybeep pair --json --expect-email you@example.com
```

On timeout the terminal line is `{ "paired": false, "reason": "timeout" }` (exit code 1). Scripts
should read the **last** parseable line for the outcome and the **first** for the complete QR payload.
Every non-success exit emits a terminal line with a `reason`: `timeout`, `declined`,
`non_interactive`, `expected_email_mismatch`, `expected_email_unverifiable`, or the backend's own
error code (e.g. `quota_exceeded`).

---

## Confirming the approving account

The backend tells the CLI **which account approved** a pairing (`approved_by_email`), and the CLI
turns that into a blocking question before it trusts the minted token:

```text
Pair this machine to you@example.com? [y/N]
```

This is deliberate defense-in-depth for the social/human layer. Approval happens on your phone, and
a complete pairing link opened under the wrong account would otherwise silently produce a working
machine token. The confirm step puts a human between the mint and the trust:

- The gate runs **after** the token is minted but **before** anything is stored. Decline and the
  CLI writes **no token and no config**, and exits non-zero.
- Only `y` / `yes` (any case) is consent. Empty input, `n`, EOF, or `Ctrl-D` all decline.
- Declining does not remove the machine server-side — the approval already happened. The CLI tells
  you so; revoke the machine in the BirdyBeep app if the approval wasn't yours.

### Headless machines, CI, and fleets

| Flag / setting                   | Effect                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `--expect-email <addr>`          | Pin the expected account: pairs unattended on an exact match, **hard-fails** on a mismatch.   |
| `--yes` (`-y`)                   | Accept whichever account approved it, without asking. The blunt hatch.                        |
| `expectEmail` in `config.json`   | Same as `--expect-email`, baked into the machine's CLI config. The flag overrides it.         |
| _(none, and no terminal at all)_ | **Fails closed** with an error naming both hatches — a script is never prompted, never hangs. |

`--expect-email` is the one to reach for in CI: it is the only option that still catches a
wrong-account approval.

```bash
birdybeep pair --expect-email you@example.com        # unattended, still checked
birdybeep pair --yes                                  # unattended, unchecked
```

```text
$ birdybeep pair --expect-email you@example.com
…
Pairing refused: this machine was approved by someone@else.example, but you@example.com was
expected. The machine token was NOT stored. If you did not expect that account to approve it,
open BirdyBeep and revoke the machine, then re-run `birdybeep pair`.
```

A pin that **cannot be checked** — the server reported no approving account (an older backend) —
is also refused, rather than quietly treated as a pass. `--yes` cannot override a mismatched pin.

### Where the question is asked (and Git Bash)

The prompt is written to **stderr**, so `--json` output stays a clean NDJSON stream on stdout. The
answer is read from your terminal:

1. from **stdin**, when stdin is a terminal (the normal case); otherwise
2. **on macOS/Linux only**, from the **controlling terminal** (`/dev/tty`).

Step 2 keeps pairing usable in shells that hand programs pipe-backed stdio even though a human is
right there — `process.stdin.isTTY` is false, yet the prompt appears and your answer is read from
the terminal you are sitting at.

**Windows has no equivalent step 2.** The obvious analogue is the `CONIN$` console device, and we
measured it on a Windows runner with piped stdio: it _opens_ and then _reading it never returns_.
Using it would trade a fast, honest refusal for an indefinite hang, so `pair` does not. On Windows
you therefore get either a real TTY on stdin (PowerShell, `cmd`, Windows Terminal, VS Code — all
fine), or the fail-closed refusal. If a **Git Bash / MSYS / mintty** shell lands you in the latter,
the error points at:

```bash
winpty birdybeep pair
```

`winpty` attaches a real console, which makes stdin itself a TTY — so the ordinary prompt appears,
no fallback needed. `--non-interactive` always skips straight to the fail-closed branch, whatever
terminal is attached.

The config pin is a plain non-secret key in the CLI config file (see
[Where the token is stored](#where-the-token-is-stored) for the config location):

```json
{ "apiUrl": "https://api.birdybeep.com", "expectEmail": "you@example.com" }
```

---

## Why the QR is safe

This is the core of the trust story:

- **No durable token in the QR/link.** The pair URL carries only a short-lived approval proof. A
  leaked QR can't notify your devices or impersonate your machine — at worst someone could try to
  claim the pending pairing under an account the CLI then asks you to confirm.
- **Code-only approval is blocked.** The display code identifies the session but cannot approve it
  without the high-entropy secret from the complete QR/link.
- **Single-use proof.** The pairing session is consumed when approved and can't be replayed.
- **Short expiry.** The pairing session is time-boxed (the backend sets `expires_at` — a
  ~10-minute window). After it expires, the proof is dead and you simply run `birdybeep pair` again.
- **Token minted server-side, shown once.** The machine token is created by the backend and handed
  to the CLI exactly once during pairing. The server stores only a **hash** of it, never the token
  itself.
- **Trusted only after you confirm.** Minting is not trusting: the CLI names the approving account
  and refuses to store the token until you (or an `--expect-email` pin) accept it. A pairing
  approved by the wrong account never becomes a working machine.
- **Revocable from the app.** You can revoke (and rotate) a machine's token from the BirdyBeep
  mobile app at any time. Revoking immediately stops that machine from sending Beeps.

See [Security](./security.md) for how tokens are hashed server-side and exactly what data leaves
your machine.

---

## Where the token is stored

After a successful pairing the machine token lives in **one** of two places, chosen automatically:

- the **OS keychain** when one is available (e.g. macOS Keychain), or
- a **strict-permission file** otherwise — `0600` file inside a `0700` directory under your user
  data directory (the standard path for headless Linux/Windows boxes with no keychain).

The token is **never** written into a repo-local file or into any harness's config — agent installs
add only BirdyBeep-managed config entries and never a token. The CLI reads the token at send time;
[`birdybeep logout`](#birdybeep-logout) clears it; re-pairing overwrites it. Full details, including the file
permissions and the keychain fallback, live in [Security](./security.md).

---

## Unpair vs. logout

Two commands tear down this machine's pairing. They differ in whether they touch the **server**:

```bash
birdybeep unpair   # revoke the machine server-side AND remove the local token (the reverse of `pair`)
birdybeep logout   # remove the local token only (the machine stays on your account)
```

### `birdybeep unpair`

`unpair` is the true reverse of `pair`. It **revokes the machine on the server** — so it disappears
from the BirdyBeep app and its token stops working everywhere — and then removes the local token:

```text
Unpaired — the machine was revoked and removed from your account.
```

If the backend can't be reached, `unpair` still removes the local token and tells you to finish the
job in the app, so no stale machine lingers on your account:

```text
Unpaired locally, but the server was unreachable — the machine may still show in the app. Open
BirdyBeep and revoke it there to fully remove it.
```

### `birdybeep logout`

`birdybeep logout` removes the local machine token from **both** the OS keychain and the
strict-permission file fallback, but **does not touch the server** — the machine stays paired on your
account, and you can sign back in by re-pairing:

```text
Logged out — the machine token was removed.
```

Both commands are **idempotent** (running them when already signed out is not an error) and neither
removes your agent integrations (use [`birdybeep agent uninstall`](./install.md) for that) or clears
the local event queue. You can also revoke any machine directly from the BirdyBeep app at any time —
revoking invalidates the server-side token hash even if a copy of the token still exists somewhere.

---

## Troubleshooting

- **Pairing timed out.** You didn't confirm before the window closed. Run `birdybeep pair` again
  for a fresh QR/link.
- **"Code already used."** The pairing session is single-use. Start over with `birdybeep pair`.
- **"Pairing needs confirmation … no terminal to ask on."** You ran `pair` from a script, CI job,
  or a shell with no terminal attached. Add `--expect-email <addr>` (preferred) or `--yes`. On
  Windows/Git Bash, `winpty birdybeep pair` attaches a real console instead.
- **"Pairing refused: … but `<addr>` was expected."** A different account approved the machine than
  the one you pinned. Nothing was stored. Check who approved it in the app, revoke the machine if
  it wasn't you, then re-run.
- **Paired to the wrong account by mistake.** Run `birdybeep unpair` to revoke the machine and drop
  the local token, then pair again with `--expect-email` set.
- **Not receiving Beeps after pairing.** Confirm the machine is still authorized in the app (it may
  have been revoked) and run `birdybeep doctor` to check the token, adapters, and backend
  reachability.

See [Troubleshooting](./troubleshooting.md) for more, and [Install](./install.md) for connecting
your coding agents after you've paired.
