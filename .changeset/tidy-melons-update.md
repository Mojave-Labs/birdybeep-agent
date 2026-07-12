---
"@birdybeep/cli": minor
---

Add `birdybeep update` — a read-only check-and-notify command that asks the npm registry for the
latest published `@birdybeep/cli`, compares it against the running version, and prints the exact
upgrade command (`npm install -g @birdybeep/cli@latest`, plus pnpm/yarn equivalents) when you're
behind. It never mutates your install — you stay in control of when and how you upgrade — and is
best-effort: if the registry can't be reached it says so and exits non-zero without blocking.
Supports `--json` (`{ current, latest, updateAvailable, upgradeCommand }`) and honors a custom
`npm_config_registry`.
