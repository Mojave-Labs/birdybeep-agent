# Pairing

`birdybeep login` pairs this machine with your BirdyBeep account so the agent adapters can send
you Beeps (notifications). Pairing uses a device-authorization-style flow: the CLI shows you a
short link and a code, you confirm in the BirdyBeep mobile app, and the CLI receives and stores a
machine token locally.

The important part of the trust story up front: **the QR / link carries only a short-lived
pairing code — never a durable token.** The machine token is minted server-side, returned to the
CLI once, and stored locally in your OS keychain (or a strict-permission file). See
[Security](./security.md) for the full token-handling details.

> **Wire contract.** The pairing endpoints (`POST /v1/pair/start`, `POST /v1/pair/token`) are a
> cross-repo contract owned by the BirdyBeep product backend; the request/response schemas are
> mirrored field-for-field in `agent-core` (kept in lockstep with the product's `packages/schemas`).
> The CLI reads responses tolerantly. The live `birdybeep login` pass against the product backend
> is a deferred follow-up.

---

## Quick start

```bash
birdybeep login
```

You'll see a link and a code. Open the link (or scan the QR), confirm the code in the BirdyBeep
app, and wait for the CLI to report success:

```text
To pair this machine, scan the code or open the link, then confirm in the app:
   Scan or open:  birdybeep://pair?code=WXYZ-1234
   Code:  WXYZ-1234
Waiting for confirmation…
✓ Paired. Run `birdybeep test` to send a test Beep.
```

`birdybeep login` derives this machine's label from your hostname/OS and sends it when it opens
the session (editable later in the app). Once paired, run [`birdybeep test`](./install.md) to send
a test Beep, or `birdybeep status` to check integration state.

---

## How the device flow works

1. **Start.** `birdybeep login` calls `POST /v1/pair/start` with this machine's label (derived from
   your hostname/OS), its OS, and the CLI version. The backend returns a **device code**, a
   human-typeable **user code**, a **QR payload** (which encodes only the short user code), and an
   **`expires_at`** for the pairing session.
2. **Confirm.** You scan the QR or open the link and confirm the user code in the BirdyBeep mobile
   app. The app shows an approval screen for this machine.
3. **Poll.** Meanwhile the CLI polls `POST /v1/pair/token` with the device code (and a stable,
   non-reversible machine fingerprint). Until you approve, the backend replies with a
   `validation_failed`/4xx, which the CLI treats as "not yet — keep polling".
4. **Mint.** When you approve, the backend mints a **machine token** server-side and the next poll
   returns `201 { machine_token, machine_id }`.
5. **Store.** The CLI writes the machine token to the secure token store (keychain, else a
   strict-permission file) and saves the non-secret API URL to its config. The token is **never**
   written into a repo file or any harness config.

If you don't confirm before the pairing session expires, the CLI stops polling and tells you to
retry:

```text
Pairing timed out before it was confirmed. Run `birdybeep login` to retry.
```

The pairing session is short-lived (the backend sets `expires_at` — a ~10-minute window), the user
code is single-use, and the device code only lets the CLI ask "am I approved yet?" — it is **not**
the machine token.

---

## QR vs. manual code

The pair URL is QR-friendly: it's short and encodes only the pairing session, so it scans cleanly
and you can open it on your phone with one tap. **Both paths are equivalent** — scanning the QR and
typing the code at the link land you on the same approval screen in the app.

Today the CLI renders the pair URL as a plain link (a QR-matrix renderer is a planned follow-up),
so in practice you'll either:

- **open the link** on a device where you're signed in to the BirdyBeep app, or
- **type the short user code** into the pairing screen in the app.

Either way you confirm the same single-use code shown in the terminal.

### Headless and SSH machines

Many agent boxes are remote — a CI runner, a cloud dev box, a server you reach over SSH. There's no
browser or camera there, and that's fine: pairing never needs one. The CLI prints the pair URL and
the **user code** as plain text, so you:

1. Run `birdybeep login` on the remote machine.
2. Copy the link or the short code from the terminal.
3. Open the link (or enter the code) in the BirdyBeep app on **any** device — your phone or a
   laptop.
4. Confirm. The remote CLI's next poll picks up the approval and stores the token there.

Because the confirmation happens on a device of your choosing and only the short code crosses over,
you can pair a headless box without ever exposing a browser or token on it.

### Non-interactive mode

`birdybeep login` works with the global `--non-interactive` flag (never prompts, fails fast) and
`--json` (machine-readable output). In `--json` mode the success line is emitted as a JSON object,
for example:

```json
{ "paired": true, "machineLabel": "my-laptop" }
```

---

## Why the QR is safe

This is the core of the trust story:

- **No durable token in the QR/link.** The pair URL and user code carry only short-lived pairing
  info. A leaked QR can't notify your devices or impersonate your machine — at worst someone could
  try to claim a pairing session that you'd then have to approve in the app.
- **Single-use code.** The user code is consumed when you approve it; it can't be replayed.
- **Short expiry.** The pairing session is time-boxed (the backend sets `expires_at` — a
  ~10-minute window). After it expires, the code is dead and you simply run `birdybeep login` again.
- **Token minted server-side, shown once.** The machine token is created by the backend and handed
  to the CLI exactly once during pairing. The server stores only a **hash** of it, never the token
  itself.
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
[`birdybeep logout`](#logout) clears it; re-pairing overwrites it. Full details, including the file
permissions and the keychain fallback, live in [Security](./security.md).

---

## Logout

```bash
birdybeep logout
```

`birdybeep logout` removes the local machine token from **both** the OS keychain and the
strict-permission file fallback:

```text
Logged out — the machine token was removed.
```

It's **idempotent** — running it when you're already logged out is not an error. Logout only
touches the token; it does **not** remove your agent integrations (use
[`birdybeep agent uninstall`](./install.md) for that) or clear the local event queue.

To fully sign a machine out everywhere, run `birdybeep logout` on the machine **and** revoke its
token from the BirdyBeep app — revoking invalidates the server-side hash even if a copy of the
token still exists somewhere.

---

## Troubleshooting

- **Pairing timed out.** You didn't confirm before the window closed. Run `birdybeep login` again
  for a fresh code.
- **"Code already used."** The user code is single-use. Start over with `birdybeep login`.
- **Not receiving Beeps after pairing.** Confirm the machine is still authorized in the app (it may
  have been revoked) and run `birdybeep doctor` to check the token, adapters, and backend
  reachability.

See [Troubleshooting](./troubleshooting.md) for more, and [Install](./install.md) for connecting
your coding agents after you've paired.
