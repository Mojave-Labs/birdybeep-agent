# Pairing

`birdybeep login` pairs this machine with your BirdyBeep account so the agent adapters can send
you Beeps (notifications). Pairing uses a device-authorization-style flow: the CLI shows you a
short link and a code, you confirm in the BirdyBeep mobile app, and the CLI receives and stores a
machine token locally.

The important part of the trust story up front: **the QR / link carries only a short-lived
pairing code — never a durable token.** The machine token is minted server-side, returned to the
CLI once, and stored locally in your OS keychain (or a strict-permission file). See
[Security](./security.md) for the full token-handling details.

> **Provisional endpoints.** The pairing protocol (`POST /v1/cli/pair`,
> `POST /v1/cli/pair/poll`) is a cross-repo contract owned by the BirdyBeep product backend and is
> **not yet pinned** — paths and field names may change before the live `birdybeep login` ships.
> The CLI reads responses tolerantly, so a shape tweak won't crash it, but treat this page's wire
> details as subject to change.

---

## Quick start

```bash
birdybeep login
```

You'll see a link and a code. Open the link (or scan the QR), confirm the code in the BirdyBeep
app, and wait for the CLI to report success:

```text
To pair this machine, open the link and confirm the code:
   Scan or open:  https://app.birdybeep.dev/pair/XXXX
   Code:  WXYZ-1234
Waiting for confirmation…
✓ Paired as my-laptop. Run `birdybeep test` to send a test Beep.
```

The machine label (`my-laptop` above) comes from your account and is only shown if the backend
returns one. Once paired, run [`birdybeep test`](./install.md) to send a test Beep, or
`birdybeep status` to check integration state.

---

## How the device flow works

1. **Start.** `birdybeep login` calls `POST /v1/cli/pair`. The backend returns a short **pair URL**,
   a human-typeable **user code**, an opaque **poll token**, a poll **interval**, and an
   **expiry** for the pairing session.
2. **Confirm.** You open the pair URL (QR or manual) and confirm the code in the BirdyBeep mobile
   app. The app shows an approval screen for this machine.
3. **Poll.** Meanwhile the CLI polls `POST /v1/cli/pair/poll` with the poll token at the interval
   the backend specified. Each poll returns `pending` until you approve.
4. **Mint.** When you approve, the backend mints a **machine token** server-side and the next poll
   returns `{ status: "paired", machine_token }` (plus an optional machine label).
5. **Store.** The CLI writes the machine token to the secure token store (keychain, else a
   strict-permission file) and saves the non-secret API URL to its config. The token is **never**
   written into a repo file or any harness config.

If you don't confirm before the pairing session expires, the CLI stops polling and tells you to
retry:

```text
Pairing timed out before it was confirmed. Run `birdybeep login` to retry.
```

The pairing session is short-lived (the backend supplies the expiry; the CLI falls back to a
5-minute window), the user code is single-use, and the poll token only lets the CLI ask "am I
paired yet?" — it is **not** the machine token.

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
- **Short expiry.** The pairing session is time-boxed (the backend sets the expiry; the CLI's
  fallback is 5 minutes). After it expires, the code is dead and you simply run `birdybeep login`
  again.
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
