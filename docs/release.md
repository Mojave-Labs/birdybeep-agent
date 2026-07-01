# Releasing `@birdybeep/*`

The public packages are published to npm with the **Changesets "Version PR" flow** — the
de-facto standard for open-source npm monorepos (Turborepo, Astro, tRPC, Radix, and many
others release the same way). Merging a bot-generated PR is the release switch, so **ordinary
commits to `main` never publish** — only a deliberate merge does.

## The published packages

A single **fixed group** (`.changeset/config.json`) that shares one version and releases
together:

- `@birdybeep/cli`
- `@birdybeep/agent-core`
- `@birdybeep/claude-code`
- `@birdybeep/codex`
- `@birdybeep/opencode`

`@birdybeep/test-harness` is private (`"private": true`) and in the changeset `ignore` list —
it is never published. Everything else is public (`access: public`), because the CLI depends on
the four `@birdybeep/*` packages at runtime, so they must resolve on npm.

## Day-to-day: record intent with a changeset

Every PR that changes a publishable package must include a changeset. CI enforces this
(`changeset status` job) — a PR without one fails.

```bash
pnpm changeset      # pick patch/minor/major, write a short user-facing summary
```

Commit the generated `.changeset/*.md` file with your PR. (The bump you pick applies to the
whole fixed group.)

## Cutting a release (automated)

1. Merge feature PRs to `main` as usual — each carries its changeset. Nothing publishes yet.
2. `.github/workflows/release.yml` runs on push to `main` and opens/updates a **"Version
   Packages"** PR that consumes the pending changesets: bumps versions, cascades internal
   dependency ranges, and writes each `CHANGELOG.md`.
3. **Merge the Version PR when you want to ship.** That is the deliberate release trigger. The
   workflow then runs `pnpm release:ci` (build → `check-pack` packaging guard → `changeset
publish`), which publishes the fixed group to npm in dependency order and pushes git tags.

For the very first release, the pending changeset bumps `0.0.0 → 0.0.1`; merging the Version PR
ships `0.0.1` publicly.

### One-time repo setting (so the Version PR can open)

`changesets/action` opens the "Version Packages" PR using the built-in `GITHUB_TOKEN`. GitHub
blocks that by default, so enable it once: **Settings → Actions → General → Workflow permissions
→ check "Allow GitHub Actions to create and approve pull requests."** If the org enforces this
at the org level, it must be enabled there too — the org setting wins. Without it, the release
workflow runs `changeset version` and pushes the `changeset-release/main` branch but fails at the
final "create pull request" step with `GitHub Actions is not permitted to create ... pull
requests` (you can still open that PR by hand from the pushed branch as a fallback).

## HUMAN-REQUIRED before the first publish (`A-HUMAN-NPM`)

The workflow is inert until a human does these once:

1. Create the `@birdybeep` npm org (or claim the scope) with the intended maintainer.
2. Create an npm **automation** token (Access Tokens → Generate → _Automation_; it bypasses
   2FA-on-publish, which CI requires). Grant it publish rights to the `@birdybeep` scope.
3. Add it as the repo secret **`NPM_TOKEN`** (Settings → Secrets and variables → Actions).
4. **Make the repo public** before publishing — npm provenance (`NPM_CONFIG_PROVENANCE`,
   enabled in the workflow) requires a public source repo at publish time.

Until you're ready to ship publicly, just don't merge the Version PR — test the built CLI
locally first (see below).

## Testing the package locally (before any real publish)

Fastest → most realistic:

```bash
pnpm release   # dry-run: build + packaging guard + `npm pack --dry-run` plan, ZERO registry calls
pnpm smoke     # packs all 5, installs @birdybeep/cli from tarballs into a clean temp project, runs the bin
```

For a true `npm install -g` dress rehearsal, publish to a local registry (Verdaccio) — no
credentials, nothing touches real npm. **`scripts/verdaccio-rehearsal.sh` does the whole thing**
(starts Verdaccio, publishes all five with pnpm, global-installs the CLI into an isolated prefix,
runs it, and tears down on exit):

```bash
./scripts/verdaccio-rehearsal.sh          # PORT=4874 ./scripts/... if 4873 is busy
```

Or by hand, if you want to see the moving parts:

```bash
npx verdaccio &                                   # local registry on http://localhost:4873
pnpm -r publish --registry http://localhost:4873 --no-git-checks --access public
npm install -g @birdybeep/cli --registry http://localhost:4873
birdybeep --help
```

**Always publish with `pnpm`, never `npm`.** `pnpm publish` (and `changeset publish`, which
shells out to it) rewrites the `workspace:*` dependency ranges to real versions; a raw
`npm publish` ships them verbatim, so `npm install` then fails with
`Unsupported URL Type "workspace:"`. `npm install` itself is fine — the rule is publish-only.

Because every package sits at the same version until a release bumps it, the registry rejects
re-publishing an existing version. **To reset a Verdaccio run, wipe its storage and republish all
five** rather than `npm unpublish` (unpublish leaves stale state that makes `pnpm` skip the
re-publish):

```bash
# stop verdaccio, then remove its storage (exact path is in verdaccio's startup log; commonly):
rm -rf ~/.local/share/verdaccio/storage ~/.config/verdaccio/storage
# restart verdaccio, then re-run the `pnpm -r publish` above.
```

## Manual escape hatch

`scripts/release.mjs` (`pnpm release`) is the human dry-run/manual path — dry-run by default; a
real local publish needs `--publish` **and** `RELEASE_CONFIRM=1` **and** npm auth. In normal
operation you never need it; the GitHub Actions flow above is the supported path.
