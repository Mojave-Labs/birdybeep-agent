---
"@birdybeep/cli": minor
---

Add a passive update notifier. Instead of a manual command, the CLI now checks the npm registry for
a newer `@birdybeep/cli` on its own and prints a one-line "new version available" notice to stderr
after you run a command, so you learn about upgrades just by using the tool.

The check is deliberately unobtrusive: it's cached (the registry is hit at most once a day; every
other run reads a local cache), it never runs on the `hook` hot path, and it's skipped for `--json`,
`--non-interactive`, non-TTY output, and CI. It can be disabled with `NO_UPDATE_NOTIFIER=1` (or
`BIRDYBEEP_NO_UPDATE_NOTIFIER=1`) and honors a custom `npm_config_registry`. It's best-effort and
never affects a command's output or exit code.
