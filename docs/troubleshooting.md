# Troubleshooting

This page maps real BirdyBeep symptoms to fixes. It is built around the output of `birdybeep doctor`,
the self-service troubleshooter — so the fastest path is almost always:

```bash
birdybeep doctor
```

`doctor` is **read-only**: it never edits your harness config and never prints token material or
notification contents. It checks your machine token, each detected harness, the local event queue, and
backend reachability; prints a copy-pasteable fix under every failed check; and **drains the local queue**
on its way through. It exits non-zero if any check fails, so it is safe to use in scripts and CI.

A clean run ends with:

```
All checks passed.
```

A run with failures ends with:

```
Some checks failed — see fixes above.
```

> Looking for install steps? See [`install.md`](install.md). Want the privacy/security rationale (what
> leaves the machine, how tokens are stored)? See [`security.md`](security.md).

---

## How to read `doctor` output

Each line is a single check. A passing check starts with `✓`; a failing one starts with `✗` and is
followed by an indented `→` fix:

```
✓  Machine token
✓  Claude Code: Claude Code installed
✗  Codex: Codex hooks trusted — BirdyBeep hooks are installed but Codex has not fired a trusted lifecycle hook yet. Until they are trusted, Codex silently skips them, so no beeps will arrive.
     → Open Codex and run /hooks to trust the BirdyBeep hooks.
✓  Local queue — 0 queued → 0 delivered, 0 remaining
✓  Backend reachable

Some checks failed — see fixes above.
```

Per-harness checks are prefixed with the harness name (`Claude Code:`, `Codex:`, `OpenCode:`,
`Cursor:`, `GitHub Copilot CLI:`). For a shorter snapshot of just pairing + per-harness status +
queue depth, use:

```bash
birdybeep status
```

`status` prints each integration's state (`installed`, `not_detected`, `needs_trust`, `needs_restart`,
`unknown`, `error`, `revoked`) and also drains the queue opportunistically. It exits non-zero when
you are not paired.

Want machine-readable output for either command? Add `--json` — every finding is mirrored there.

---

## Symptom → fix

### Integration shows `not_detected`

**Symptom** — `status` shows a harness as `not_detected`, or `doctor` prints:

```
✗  Claude Code: Claude Code installed — Claude Code was not found on this machine.
     → Install Claude Code, then re-run `birdybeep agent install claude`.
```

The equivalent for the other harnesses:

```
✗  Codex: Codex installed — Codex was not found on this machine.
     → Install Codex, then re-run `birdybeep agent install codex`.

✗  OpenCode: OpenCode installed — OpenCode was not found on this machine.
     → Install OpenCode, then re-run `birdybeep agent install opencode`.

✗  Cursor: Cursor installed — Cursor was not found on this machine.
     → Install Cursor, then re-run `birdybeep agent install cursor`.

✗  GitHub Copilot CLI: GitHub Copilot CLI installed — The `copilot` CLI and configuration directory were not found.
     → Install GitHub Copilot CLI, then run `birdybeep agent install copilot`.
```

**Fix** — BirdyBeep could not detect the harness binary. Install (or fix the `PATH` for) the harness,
then re-run the matching install command. Once the harness is detected, the rest of that harness's
checks appear.

---

### Codex shows `needs_trust`

**Symptom** — `status` shows `Codex: needs_trust`, or `doctor` prints:

```
✗  Codex: Codex hooks trusted — BirdyBeep hooks are installed but Codex has not sent an event yet.
     → Open Codex and run /hooks to trust the BirdyBeep hooks.
```

**Why** — writing the lifecycle hooks into `~/.codex/config.toml` is **not** enough to count as
installed: Codex requires a **one-time trust** of those hooks. Until a trusted **lifecycle hook**
actually fires, BirdyBeep reports `needs_trust` rather than `installed`. (A turn-complete beep
arriving from a `notify` program does **not** count — `notify` runs without trust, so it is no proof
the hooks are trusted.)

**Fix** — open Codex and run:

```
/hooks
```

Trust the BirdyBeep hooks. The status flips to `installed` after the **first trusted lifecycle hook**
fires — it does not flip the moment you trust. Just keep working in Codex; the next lifecycle event (a
session start, a tool call, an approval prompt, etc.) marks it trusted, and `doctor` will then show:

```
✓  Codex: Codex hooks trusted
```

---

### OpenCode shows `needs_restart`

**Symptom** — `status` shows `OpenCode: needs_restart`, or `doctor` prints:

```
✗  OpenCode: OpenCode plugin loaded — The BirdyBeep plugin is configured but OpenCode has not sent an event yet.
     → Restart OpenCode so it loads the BirdyBeep plugin.
```

**Why** — OpenCode loads plugins **only at startup**. The `@birdybeep/opencode` entry is in your
`opencode.json`, but the running OpenCode process started before it was added, so the plugin is not loaded
yet. BirdyBeep reports `needs_restart` until the first event proves the plugin loaded.

**Fix** — fully restart OpenCode. After it restarts and the plugin emits its first event, the status flips
to `installed`:

```
✓  OpenCode: OpenCode plugin loaded
```

---

### Integration shows `unknown` (harness present, BirdyBeep not installed)

**Symptom** — `doctor` prints one of:

```
✗  Claude Code: BirdyBeep hooks installed — BirdyBeep hooks are not installed.
     → Run `birdybeep agent install claude` to (re)install the hooks.

✗  Codex: BirdyBeep hooks installed — BirdyBeep is not installed in Codex.
     → Run `birdybeep agent install codex` to (re)install the hooks. It adds only BirdyBeep entries and leaves any other tool's Codex config alone.

✗  OpenCode: BirdyBeep plugin configured — The `@birdybeep/opencode` plugin is not in opencode.json.
     → Run `birdybeep agent install opencode` to add the plugin.

✗  Cursor: BirdyBeep hooks installed — BirdyBeep hooks are not installed.
     → Run `birdybeep agent install cursor` to (re)install the hooks.

✗  GitHub Copilot CLI: BirdyBeep hooks installed — BirdyBeep's Copilot hook file is not installed.
     → Run `birdybeep agent install copilot` to install the current hooks.
```

**Fix** — the harness is detected, but BirdyBeep's managed entries are not present. Run the matching
install command. Installs are idempotent, back up the original config once, and add only BirdyBeep-managed
entries — re-running is always safe.

---

### Partial install / malformed config shows `error`

A harness reports `error` when its config is corrupt or only half-configured. The common shapes:

**Malformed config** — the config file is not valid:

```
✗  Claude Code: settings.json is valid JSON — ~/.claude/settings.json is not valid JSON.
     → Fix the JSON in ~/.claude/settings.json (or delete it), then run `birdybeep agent install claude`.

✗  Codex: config.toml is valid TOML — ~/.codex/config.toml is not valid TOML.
     → Fix the TOML in ~/.codex/config.toml (or delete it), then run `birdybeep agent install codex`.

✗  OpenCode: opencode.json is valid JSON — ~/.config/opencode/opencode.json is not valid JSON.
     → Fix the JSON in ~/.config/opencode/opencode.json (or delete it), then run `birdybeep agent install opencode`.

✗  Cursor: hooks.json is valid JSON — ~/.cursor/hooks.json is not valid JSON.
     → Fix the JSON in ~/.cursor/hooks.json (or delete it), then run `birdybeep agent install cursor`.

✗  GitHub Copilot CLI: BirdyBeep hook file valid JSON — ~/.copilot/hooks/birdybeep.json is not valid JSON.
     → Repair or remove the file, then run `birdybeep agent install copilot`.
```

BirdyBeep will not write into a config file it cannot parse (that would risk destroying your settings).
Fix the JSON/TOML by hand or remove the file, then re-run the install command.

If BirdyBeep had already installed successfully, it left a one-time copy of your original config next to
it with a `.birdybeep-backup` suffix — and the `→ fix` line points straight at it instead:

```
✗  Cursor: hooks.json is valid JSON — ~/.cursor/hooks.json is not valid JSON.
     → Restore the BirdyBeep backup at ~/.cursor/hooks.json.birdybeep-backup over ~/.cursor/hooks.json
       (or delete the malformed file), then run `birdybeep agent install cursor`.
```

All five adapters print the same two shapes against their own config file
(`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json`,
`~/.cursor/hooks.json`, `~/.copilot/hooks/birdybeep.json`) — the backup line only appears when that
`.birdybeep-backup` file actually exists, so you are never told to restore something you never had.

**Partial install** — only some of the managed entries are present:

```
✗  Claude Code: BirdyBeep hooks installed — Only 2/6 BirdyBeep hooks are installed (partial).
     → Run `birdybeep agent install claude` to (re)install the hooks.
```

Codex and Cursor report the same partial state across their managed lifecycle hooks. Copilot reports
`error` if its dedicated managed file has drifted from the current exact format. Re-running the
matching install repairs it while preserving the one-time backup.

**Read-only config** — BirdyBeep cannot write the file:

```
✗  Claude Code: settings.json writable — ~/.claude/settings.json is not writable.
     → Fix file permissions so BirdyBeep can update Claude Code settings.
```

(Codex, OpenCode, Cursor, and Copilot print the analogous config-path writable checks.) Fix the
file/directory permissions so BirdyBeep can update — and later cleanly uninstall — the config.

---

### `pair` refuses with "no terminal to ask on" (Git Bash / CI)

**Symptom** — `birdybeep pair` gets as far as the approval, then refuses:

```
Pairing needs confirmation (approved by you@example.com), but there is no terminal to ask on, so the
machine token was NOT stored. Re-run with `--expect-email <addr>` to pin the approving account
(recommended for CI), or `--yes` to accept whichever account approved it.
```

**Why** — before it trusts a freshly minted token, `pair` asks you to confirm the account that
approved the machine. It reads that answer from stdin when stdin is a terminal, and on macOS/Linux
otherwise from the controlling terminal (`/dev/tty`). When neither exists — a script, a CI job, a
detached session — it fails closed rather than hang or silently trust. **Windows has no controlling-
terminal fallback at all**: `CONIN$` opens even with no console attached and then blocks forever on
read, so using it would hang instead of refusing.

**Fix** — pick the one that matches where you are:

- **CI / scripts:** `birdybeep pair --expect-email you@example.com` (still catches a wrong-account
  approval), or `birdybeep pair --yes` to skip the check entirely.
- **Windows Git Bash / MSYS / mintty:** these can hand programs pipe-backed stdio, and there is no
  console fallback on Windows (see above), so run:

  ```bash
  winpty birdybeep pair
  ```

  which attaches a real console — stdin becomes a TTY and the prompt appears normally. PowerShell,
  `cmd`, Windows Terminal, and the VS Code terminal all provide a real TTY and never hit this.

- `--non-interactive` always takes this branch, whatever terminal is attached.

---

### Missing or revoked machine token

**Symptom** — `doctor` prints:

```
✗  Machine token — No machine token found.
     → Run `birdybeep pair` to pair this machine.
```

You may also see a per-harness variant:

```
✗  Codex: Machine token present — No BirdyBeep machine token found.
     → Run `birdybeep pair` to pair this machine.
```

And `status` shows:

```
Paired:  no — run `birdybeep pair`
```

**Fix** — pair the machine:

```bash
birdybeep pair
```

`pair` runs a device-flow pairing: it shows a QR and its complete link, then polls until you approve
it from the mobile app. The displayed session code is identification only and cannot approve by
itself. On success the CLI stores the machine token in the OS keychain (or, where there is no
keychain, a strict-permission file in your user config directory). The token is **never** written
into harness config or any repo file.

> The pairing endpoints are provisional and may change in a future release.

**If your pairing session expired or was already used**, run `birdybeep pair` again to get a fresh
QR/link — pairing proofs are short-lived and single-use.

**If you revoked the machine from the mobile app**, the stored token stops working. Tokens are shown once
and can be revoked at any time; the server only ever stores token _hashes_. Re-pair with `birdybeep pair`.
To clear a stale local token first:

```bash
birdybeep logout   # removes the token from keychain + file fallback; safe to run anytime
```

**To remove a machine entirely** (so it stops showing in the app), run `birdybeep unpair` instead —
it revokes the machine on the server _and_ clears the local token. `logout` only clears the local
token; the machine stays paired on your account until you unpair it here or revoke it in the app.

---

### Backend unreachable

**Symptom** — `doctor` prints:

```
✗  Backend reachable — Could not reach https://api.birdybeep.dev.
     → Check your network; queued events will retry automatically.
```

(The URL shown is whatever BirdyBeep is configured to use.)

**Fix** — this is a network reachability check (a quick `HEAD` probe). Check your connection, VPN, or
proxy. You do **not** lose events while offline: anything that failed to deliver is in the local queue and
retries automatically the next time the queue drains (see below). Once connectivity returns, run
`birdybeep doctor` (or `birdybeep status`) and the queue drains on the spot.

---

### Events are queued / offline (delivery deferred)

**Symptom** — `doctor` or `status` shows a non-zero queue, e.g.:

```
✓  Local queue — 3 queued → 3 delivered, 0 remaining
```

or, while still offline:

```
✓  Local queue — 3 queued → 0 delivered, 3 remaining
```

**Why this is normal** — there is **no background daemon**. When the harness fires an event and delivery
fails (offline, backend down, token missing), the hook writes the event to a local, best-effort queue and
**returns fast** — it never blocks or slows your coding harness. Queued events have **24-hour retention**
and live in a strict-permission file.

**How it drains** — the queue drains _opportunistically_ whenever BirdyBeep runs anyway: on the next
`birdybeep hook` (i.e. your next harness event), or any time you run `birdybeep status` or
`birdybeep doctor`. The `→ delivered, → remaining` numbers in those commands report exactly what drained.

**Fix** — usually nothing: fix connectivity (or your token) and let the next event, `status`, or `doctor`
flush the queue. To force a drain right now:

```bash
birdybeep doctor   # or: birdybeep status — both drain on the way through
```

**Stuck queue?** If something is wedged and you want to drop locally queued events (debugging only):

```bash
birdybeep queue clear   # drops ALL locally-queued events — they will not be delivered
```

This is destructive for whatever is queued, so use it only when you are fine losing those pending events.

---

### Push notification not arriving (but `doctor` is all green)

If `doctor` shows everything passing and the event delivered, but no push reached your phone, the event
made it to the backend — the issue is downstream of this CLI. Check the **in-app push status / delivery
log in the mobile app** for that event (delivery problems, notification permissions, or a muted machine
are surfaced there). You can also confirm the end-to-end path from this machine with:

```bash
birdybeep test
```

`test` sends a real test event through the actual sender path and reports whether it was **delivered** or
**queued**.

---

### Cursor sends events even though you only installed the Claude Code hooks

Cursor desktop reads `~/.claude/settings.json` and runs the hook commands it finds there, so it fires
`birdybeep hook claude` with a Cursor payload. Those events are handled by the Cursor adapter and arrive
as `harness: "cursor"`. `birdybeep hook claude --json` reports them as:

```json
{ "harness": "cursor", "routedFrom": "claude", "outcome": "delivered" }
```

Cursor's bridge does not support `Notification` or `PermissionRequest`, so approval beeps never come
through it. For full coverage install the Cursor adapter as well:

```bash
birdybeep agent install cursor
```

Events that arrive twice are collapsed by the dedup ledger, so running both is safe.

---

### A hook fire exits non-zero with "not a … hook event"

The payload piped into `birdybeep hook <harness>` carried a `hook_event_name` that harness never fires,
so nothing was sent. Check which tool is invoking the hook — usually a hook command copied into another
harness's config file. Every other outcome, including a deliberately unmapped event, exits 0.

---

## Still stuck?

1. Run `birdybeep doctor --json` and capture the output (it contains no secrets — no tokens, no
   notification contents).
2. Confirm you are paired with `birdybeep status`.
3. Re-run the relevant `birdybeep agent install <harness>` — it is idempotent and non-destructive.
4. For Codex, remember it stays `needs_trust` until the **first event after** you run `/hooks`; for
   OpenCode, `needs_restart` until the **first event after** a restart. Trigger one event in the harness
   and re-check.
5. Claude Code, Cursor, and GitHub Copilot CLI require no trust or restart step. If their config is present but
   status is not `installed`, re-run the matching install command and inspect the reported config
   path for malformed or manually edited managed entries.
