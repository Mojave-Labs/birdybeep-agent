---
"@birdybeep/codex": minor
"@birdybeep/cli": patch
---

Register Codex's `[[hooks.Stop]]` for turn-complete and stop writing the single-slot `notify`
program. `notify` is a scalar any tool can claim, so BirdyBeep's installer used to overwrite
whatever was there — destroying other tools' Codex integrations. Install is now
non-destructive: a foreign `notify` is left in place and reported, and uninstall never touches
a value that is not ours. Backups are no longer written once-and-only-once, so no overwrite is
unrecoverable.

If the slot still holds BirdyBeep's own older value, install now hands it back to the program
that value displaced — read from the backup taken at the time — instead of just clearing it, so
upgrading repairs an integration a previous version broke.

Turn-complete now arrives via the append-only, trust-gated hooks array, carrying `session_id`,
`turn_id` and `model` — strictly more than `notify` provided.

Existing users must re-run Codex's `/hooks` to trust the new `Stop` entry.
