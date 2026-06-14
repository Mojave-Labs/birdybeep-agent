# Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to version the public
packages and generate their changelogs. The published packages are a **fixed group** — they
share one version and release together: `@birdybeep/cli`, `@birdybeep/agent-core`,
`@birdybeep/claude-code`, `@birdybeep/codex`, `@birdybeep/opencode`. (`@birdybeep/test-harness`
is private and ignored.)

## Contributor flow

1. Make your change on a branch.
2. Record the release intent:

   ```bash
   pnpm changeset
   ```

   Pick the bump level (patch / minor / major) and write a short, user-facing summary. This
   writes a markdown file under `.changeset/` — commit it with your PR.

3. CI runs `pnpm changeset:status` and fails if you changed a publishable package without a
   changeset, so versions never drift out of someone's head.

## Release flow (maintainers — see `scripts/release.ts`)

```bash
pnpm changeset:version   # consume changesets → bump versions + cascade ranges + write CHANGELOGs
pnpm release             # build + pack-check + publish DRY-RUN (real publish is a separate, gated step)
```

`changeset version` applies the highest pending bump across the fixed group, cascades internal
dependency ranges, and updates each package's `CHANGELOG.md`. Those changes are committed, not
hand-edited.
