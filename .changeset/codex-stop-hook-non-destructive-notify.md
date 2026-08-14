---
"@birdybeep/codex": minor
"@birdybeep/cli": patch
---

Register Codex's `[[hooks.Stop]]` for turn-complete and stop writing the single-slot `notify`
program. `notify` is a scalar any tool can claim, so BirdyBeep's installer used to overwrite
whatever was there — destroying other tools' Codex integrations. Install is now
non-destructive: a foreign `notify` is left in place and reported, only BirdyBeep's own legacy
value is cleared, and uninstall never touches a value that is not ours. Backups are no longer
written once-and-only-once, so no overwrite is unrecoverable.

Turn-complete now arrives via the append-only, trust-gated hooks array instead, carrying
`session_id`, `turn_id` and `model` — strictly more than `notify` provided.

Existing users must re-run Codex's `/hooks` to trust the new `Stop` entry.
