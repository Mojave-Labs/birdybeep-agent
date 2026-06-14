# Examples — generated config per harness

BirdyBeep edits real config files in your home directory, so we keep a committed, **byte-for-byte**
copy of exactly what each installer writes. An auditor (or you) can read these before running
anything and see the complete footprint BirdyBeep adds to a coding harness.

These are not hand-written approximations — each file is the same artifact the adapter's snapshot
tests assert against, so it stays in lockstep with the real generated output and CI catches any
drift.

## Index

| Harness                                | Config file                                    | Installs to                                                   |
| -------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| [Claude Code](./claude-code/README.md) | [`settings.json`](./claude-code/settings.json) | `~/.claude/settings.json`                                     |
| [Codex](./codex/README.md)             | [`config.toml`](./codex/config.toml)           | `~/.codex/config.toml` (or `$CODEX_HOME`)                     |
| [OpenCode](./opencode/README.md)       | [`opencode.json`](./opencode/opencode.json)    | `~/.config/opencode/opencode.json` (honors `XDG_CONFIG_HOME`) |

Each example shows the **from-scratch** case — a brand-new config containing nothing but BirdyBeep's
managed entries — so the managed footprint is unmistakable. On an existing config, the installer
merges these entries in and leaves everything else untouched. Per-harness READMEs walk through both.

## Invariants every example demonstrates

- **Only BirdyBeep-managed entries are added.** Existing config is preserved, and the original is
  backed up once to a `*.birdybeep-backup` file before the first change.
- **No token is present.** Tokens live in the OS keychain (or a strict-permission file) and are read
  at event time — never written into harness config or any repo file.
- **Reversible.** `birdybeep agent uninstall <harness>` removes exactly the entries shown here and
  restores the original.
- **Idempotent.** Running install twice produces the same result, with no duplicate entries.

## Per-harness caveats

- **Codex** reports `needs_trust` until you open Codex and run `/hooks` to trust the hooks.
- **OpenCode** reports `needs_restart` until you restart OpenCode so the plugin loads.
- **Claude Code** takes effect immediately — it reads `settings.json` live, no restart or trust step.

## Learn more

- [`docs/install.md`](../docs/install.md) — install / uninstall flow
- [`docs/security.md`](../docs/security.md) — token storage and exactly what data leaves the machine
