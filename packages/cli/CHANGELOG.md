# @birdybeep/cli

## 0.2.0

### Minor Changes

- 92db742: Add a passive update notifier. Instead of a manual command, the CLI now checks the npm registry for
  a newer `@birdybeep/cli` on its own and prints a one-line "new version available" notice to stderr
  after you run a command, so you learn about upgrades just by using the tool.

  The check is deliberately unobtrusive: it's cached (the registry is hit at most once a day; every
  other run reads a local cache), it never runs on the `hook` hot path, and it's skipped for `--json`,
  `--non-interactive`, non-TTY output, and CI. It can be disabled with `NO_UPDATE_NOTIFIER=1` (or
  `BIRDYBEEP_NO_UPDATE_NOTIFIER=1`) and honors a custom `npm_config_registry`. It's best-effort and
  never affects a command's output or exit code.

### Patch Changes

- @birdybeep/agent-core@0.2.0
- @birdybeep/claude-code@0.2.0
- @birdybeep/codex@0.2.0
- @birdybeep/opencode@0.2.0

## 0.1.0

### Minor Changes

- 415796b: Rename the `birdybeep login` command to `birdybeep pair`, matching the pairing
  vocabulary used everywhere else (the `/v1/pair/*` endpoints, the mobile app's
  "pair a machine" flow, and the docs). There is no `login` alias — `pair` is the
  only name.

  Teardown now has two equivalent names: `birdybeep unpair` (the twin of `pair`)
  and `birdybeep logout` both remove the local machine token. `birdybeep status`
  reports `Paired: yes/no` (JSON field `paired`) instead of the old login wording.

### Patch Changes

- Updated dependencies [2aeeeeb]
  - @birdybeep/claude-code@0.1.0
  - @birdybeep/agent-core@0.1.0
  - @birdybeep/codex@0.1.0
  - @birdybeep/opencode@0.1.0

## 0.0.3

### Patch Changes

- Updated dependencies [03f6f61]
  - @birdybeep/agent-core@0.0.3
  - @birdybeep/claude-code@0.0.3
  - @birdybeep/codex@0.0.3
  - @birdybeep/opencode@0.0.3

## 0.0.2

### Patch Changes

- 3b66cfd: Fix `birdybeep login` hanging silently. It polled `/v1/pair/token` and treated every non-2xx response as "not approved yet", so a terminal failure (e.g. `quota_exceeded` — the agent-install cap) was masked and the CLI polled into a silent 10-minute timeout. It now surfaces terminal errors with their actionable message and exits, keeps polling only on the benign "not approved yet"/transient cases, and reprints a "still waiting — approve this machine in the BirdyBeep app…" heartbeat so the prompt is visibly alive. Copy now points at the reliable in-app scan/enter path.
  - @birdybeep/agent-core@0.0.2
  - @birdybeep/claude-code@0.0.2
  - @birdybeep/codex@0.0.2
  - @birdybeep/opencode@0.0.2

## 0.0.1

### Patch Changes

- 7501058: Point the default backend URL at the production API on the custom domain (`https://api.birdybeep.com`). Previously defaulted to the unprovisioned `api.birdybeep.dev`. Override still works via `BIRDYBEEP_API_URL` or `birdybeep login`.
- 11b72f2: Add the `repository` field (with monorepo `directory`) to every published package.json, pointing at the public GitHub repo. Required for npm provenance and Trusted Publishing (OIDC) to validate the publishing repository, and it makes the "Repository" link on npmjs.com work.
- Updated dependencies [11b72f2]
- Updated dependencies [8a385a5]
  - @birdybeep/agent-core@0.0.1
  - @birdybeep/claude-code@0.0.1
  - @birdybeep/codex@0.0.1
  - @birdybeep/opencode@0.0.1
