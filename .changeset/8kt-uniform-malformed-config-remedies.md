---
"@birdybeep/claude-code": patch
"@birdybeep/codex": patch
"@birdybeep/opencode": patch
---

Give the Claude Code, Codex and OpenCode malformed-config doctor checks the same actionable
fix line Cursor got in birdybeep-agent-tu1 (birdybeep-agent-8kt).

`birdybeep doctor` told users to "Fix or remove the malformed settings.json / config.toml /
opencode.json, then re-run install" — naming neither the file nor the command, for the one
failure `birdybeep agent install` cannot repair by itself (every installer parses before it
writes, so a corrupt config makes it throw rather than heal). All three now print the real
recovery, branching on whether the installer actually left a backup:

- backup present → "Restore the BirdyBeep backup at `<config>.birdybeep-backup` over `<config>`
  (or delete the malformed file), then run `birdybeep agent install <harness>`."
- no backup → "Fix the JSON/TOML in `<config>` (or delete it), then run
  `birdybeep agent install <harness>`."

Verified per adapter by inducing the corrupt-config failure in a temp `HOME` with the built
CLI, following the printed remedy, and confirming `doctor` comes back green — in both the
backup and the no-backup branch. The unit tests now assert the concrete path + install command
and are branch-discriminating (`not.toContain("birdybeep-backup")` on the no-backup branch —
the backup string is a superstring of the config path, so without it a stuck ternary stayed
green); the same assertion was backfilled into Cursor's test. `docs/troubleshooting.md`'s
malformed-config block now shows both shapes and is consistent across all four adapters.
