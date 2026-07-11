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
✗  Codex: Codex hooks trusted — BirdyBeep hooks are installed but Codex has not sent an event yet.
     → Open Codex and run /hooks to trust the BirdyBeep hooks.
✓  Local queue — 0 queued → 0 delivered, 0 remaining
✓  Backend reachable

Some checks failed — see fixes above.
```

Per-harness checks are prefixed with the harness name (`Claude Code:`, `Codex:`, `OpenCode:`). For a
shorter snapshot of just pairing + per-harness status + queue depth, use:

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

**Why** — Codex is special. Writing the config (`notify` + the lifecycle hooks in `~/.codex/config.toml`)
is **not** enough to count as installed: Codex requires a **one-time trust** of those hooks. Until the
first real event flows through, BirdyBeep deliberately reports `needs_trust` rather than `installed`.

**Fix** — open Codex and run:

```
/hooks
```

Trust the BirdyBeep hooks. The status flips to `installed` after the **first real event** is seen — it
does not flip the moment you trust. Just keep working in Codex; the next lifecycle event (a session
start, a tool call, etc.) marks it trusted, and `doctor` will then show:

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

✗  Codex: BirdyBeep notify + hooks installed — BirdyBeep is not installed in Codex.
     → Run `birdybeep agent install codex` to (re)install the notify + hooks.

✗  OpenCode: BirdyBeep plugin configured — The `@birdybeep/opencode` plugin is not in opencode.json.
     → Run `birdybeep agent install opencode` to add the plugin.
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
     → Fix or remove the malformed settings.json, then re-run install.

✗  Codex: config.toml is valid TOML — ~/.codex/config.toml is not valid TOML.
     → Fix or remove the malformed config.toml, then re-run install.

✗  OpenCode: opencode.json is valid JSON — ~/.config/opencode/opencode.json is not valid JSON.
     → Fix or remove the malformed opencode.json, then re-run install.
```

BirdyBeep will not write into a config file it cannot parse (that would risk destroying your settings).
Fix the JSON/TOML by hand or remove the file, then re-run the install command.

**Partial install** — only some of the managed entries are present:

```
✗  Claude Code: BirdyBeep hooks installed — Only 2/6 BirdyBeep hooks are installed (partial).
     → Run `birdybeep agent install claude` to (re)install the hooks.
```

Codex reports the same partial state across its `notify` line and lifecycle hooks. Re-running install
repairs it.

**Read-only config** — BirdyBeep cannot write the file:

```
✗  Claude Code: settings.json writable — ~/.claude/settings.json is not writable.
     → Fix file permissions so BirdyBeep can update Claude Code settings.
```

(Codex and OpenCode print the analogous `config.toml writable` / `opencode.json writable` checks.) Fix
the file/directory permissions so BirdyBeep can update — and later cleanly uninstall — the config.

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

`pair` runs a device-flow pairing: it shows a short URL and a code, then polls until you approve it from
the mobile app. On success it stores the machine token in the OS keychain (or, where there is no keychain,
a strict-permission file in your user config directory). The token is **never** written into harness
config or any repo file.

> The pairing endpoints are provisional and may change in a future release.

**If your pairing code expired or was already used**, just run `birdybeep pair` again to get a fresh
code — codes are short-lived and single-use.

**If you revoked the machine from the mobile app**, the stored token stops working. Tokens are shown once
and can be revoked at any time; the server only ever stores token _hashes_. Re-pair with `birdybeep pair`.
To clear a stale local token first:

```bash
birdybeep logout   # removes the token from keychain + file fallback; safe to run anytime
```

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

## Still stuck?

1. Run `birdybeep doctor --json` and capture the output (it contains no secrets — no tokens, no
   notification contents).
2. Confirm you are paired with `birdybeep status`.
3. Re-run the relevant `birdybeep agent install <harness>` — it is idempotent and non-destructive.
4. For Codex, remember it stays `needs_trust` until the **first event after** you run `/hooks`; for
   OpenCode, `needs_restart` until the **first event after** a restart. Trigger one event in the harness
   and re-check.
