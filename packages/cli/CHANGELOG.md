# @birdybeep/cli

## 0.3.0

### Minor Changes

- 6ad01d4: Add the Cursor adapter (`@birdybeep/cursor`) — a new harness integration.

  Cursor reads `~/.cursor/hooks.json` (`{ "version": 1, "hooks": { "<eventName>": [ { command, timeout } ] } }`) and delivers each hook's event payload as JSON on **stdin**, so the managed command is `birdybeep hook cursor` (stdin-based, matching Claude Code). Install is non-destructive + idempotent (backs up the original, adds only BirdyBeep-managed entries, byte-for-byte reversible on uninstall) and there is **no trust/restart gate** — status is `installed` the moment the entries are written.

  Event mapping (§10.1): `sessionStart` → `session_started`; `sessionEnd{final_status:"completed"}` → `agent_completed`; `sessionEnd{other}` → `session_ended`; `stop` → `agent_completed`; `beforeShellExecution` → `approval_required`; `preToolUse` → `tool_started`; `postToolUse` → `tool_finished`; `subagentStart`/`subagentStop` → `subagent_started`/`subagent_completed`; anything else → skipped.

  **CLI-fires-a-subset caveat**: headless `cursor-agent -p` fires ONLY `sessionStart` + `sessionEnd` (a version-dependent subset — the IDE fires the full documented set). That is why a completed `sessionEnd` maps to `agent_completed`: it is the only completion signal CLI users ever get, so it must produce the "your agent finished" beep. We register the full documented event set anyway so IDE users are covered.

  **Privacy**: Cursor payloads carry `user_email` (PII) and `transcript_path` (a local path). Both are **dropped entirely** — never copied into the event title/body/metadata/session-id/workspace. The only path touched is `workspace_roots[0]`, handed to the normalizer as `cwd` so it is hashed.

  **Cross-repo lockstep (§16.4)**: `HARNESS_IDS` in `@birdybeep/agent-core` gains `"cursor"` (appended last, preserving every existing ordinal), and the vendored schema-parity fixture is updated in lockstep. The private `@birdybeep/shared` `HARNESS_IDS` MUST add `"cursor"` before prod ingest (`POST /v1/agent-events`) will accept cursor events — the two halves move together.

- 6f31522: `birdybeep unpair` now revokes the machine server-side, not just locally. Previously both `unpair`
  and `logout` only removed the local machine token, so an unpaired machine kept showing in the
  BirdyBeep app. `unpair` now calls the backend's `POST /v1/machine/revoke-self` endpoint (best-effort,
  authenticated with the machine token) to revoke + purge the installation server-side, then clears the
  local token — so the machine disappears from the app. If the backend is unreachable it still clears
  the local token and tells you to revoke the machine in the app. `logout` is unchanged: it clears the
  local token only and leaves the machine paired on your account.

### Patch Changes

- 9c235e5: Fix lost Codex beeps under headless `codex exec` (exec-exit reap race). When `codex exec`
  finishes it fires its `notify` program at turn-complete and then reaps the notify child's
  process group on exit. The BirdyBeep hook was sending in-line, so on a cold/slow backend the
  send was still in flight when the group was SIGKILLed — the `agent_completed` beep was lost
  before delivery _or_ the local queue-write finished. The interactive `codex` TUI stays alive,
  so it never hit this; the bug was specific to the one-shot `codex exec` notify path.

  The notify path now re-launches `birdybeep hook codex` **detached** (`detached: true` →
  `setsid`/new session), reading the payload from a strict-perm temp file used as its stdin, and
  the notify process returns immediately. The detached worker is not in the group `codex exec`
  reaps, so it outlives the harness and completes the fast send + queue; the worker deletes the
  temp file after reading it. The payload rides a temp file (not a parent-held pipe) so the notify
  process holds no stream afterward and its prompt exit is deterministic on every platform,
  without depending on when a parent-held stdin pipe flushes and closes. The scope is limited to
  notify on POSIX: Codex lifecycle `[[hooks.X]]` events arrive on stdin and fire mid-session, and
  on Windows a child is not killed when its parent exits (no exec-exit reap race), so both send
  in-line unchanged. If `birdybeep` can't be resolved on PATH the send also falls back to in-line,
  so a best-effort delivery still happens. A new POSIX live-e2e
  (`scripts/live-e2e-codex-reap.mjs`) reproduces the real process-group reap against the built
  binary and asserts both the fast notify return and that the event is still delivered after the
  reap.

- 65abd2d: Activate the dgxd PKCE device-pairing binding from the CLI side (cross-repo lockstep with product PR #48).

  The product API already accepts an optional `code_challenge` on `POST /v1/pair/start` and, when a session was started with one, requires a matching `code_verifier` on `POST /v1/pair/token` before minting a machine token. That gate was dormant because the CLI didn't send those fields. This change turns it on:

  - **agent-core schema mirror (`pairing.ts`)** — mirrors the product's three new optional fields exactly: `pairStartRequestSchema.code_challenge` (`z.string().min(1).max(200).optional().catch(undefined)`), `pairTokenRequestSchema.code_verifier` (`z.string().min(1).optional().catch(undefined)`), and `pairTokenResponseSchema.approved_by_email` (`z.string().optional()`). Keeps the structural cross-repo guard consistent.
  - **agent-core PKCE helpers (`pkce.ts`)** — `generateCodeVerifier()` (base64url of 32 random bytes → 256-bit, URL-safe, unpadded) and `deriveCodeChallengeS256()` = `base64url(sha256(verifier))`, matching the server's `sha256Base64Url` byte-for-byte (verified against the RFC 7636 Appendix-B vector and the server's exact transform).
  - **CLI pairing flow (`pairing.ts` + `pair.ts`)** — `birdybeep pair` now generates a fresh verifier, sends its S256 challenge on `/pair/start`, keeps the verifier **in memory only** (never written to disk or the token store) for the duration of the run, and sends it on every `/pair/token` poll. The approving account (`approved_by_email`) is surfaced on success when the server reports it.

  Backward compatible both ways: the fields are optional, so an older server ignores them and the CLI still pairs; against the current server a fresh pair engages the binding, so a token can only be redeemed by the CLI that started the session.

- 6ad01d4: `birdybeep hook <harness> --json` now surfaces the backend's delivery **decision**
  (`notified` / `suppressed` / `deduped`) and HTTP `status` alongside `outcome`, when a
  send was attempted. The `outcome` alone (`delivered`) can't distinguish a beep that
  actually fired from one the backend accepted-but-suppressed — the exact failure mode
  `doctor` and delivery debugging need to see. Purely additive: fields are omitted when
  no send happened (skipped/deduped-locally), so existing script consumers are unaffected.
- 8517fc8: Mirror the two newly-formalized backend RESPONSE schemas into `agent-core` so the CLI has
  typed, runtime-validated responses (the agent-core half of product birdybeep-kje4 / #51).
  **The wire is unchanged** — the worker already emits exactly these shapes; this only pins
  the type and structure on the agent side so a future drift is caught by the cross-repo guard.

  - `agent-core/event.ts`: add `agentEventsResponseSchema` (`{ accepted, decision }`) +
    `agentEventDecisionSchema` / `AGENT_EVENT_ACCEPT_DECISIONS` (`notified` / `deduped` /
    `suppressed` — the accept-path subset; `rate_limited` / `quota_rejected` remain 429 error
    envelopes, never this shape), mirrored field-for-field from the product `packages/schemas`.
  - `agent-core/integrations.ts`: bring `integrationStatusResponseSchema` into exact lockstep —
    factor out `integrationStatusResultSchema` (`{ harness, status, updated }`) with `updated`
    now **required** (previously omitted + `.catchall`-tolerated), matching the formalized
    product contract.
  - The sender now surfaces the 202 delivery decision by validating the accept body against
    `agentEventsResponseSchema` instead of a loose hand-rolled field read, so an off-contract
    body no longer surfaces a bogus decision. No behavior change on the real wire.

- Updated dependencies [56efaf7]
- Updated dependencies [120d1ee]
- Updated dependencies [6ad01d4]
- Updated dependencies [65abd2d]
- Updated dependencies [88f1dd5]
- Updated dependencies [8517fc8]
- Updated dependencies [6ad01d4]
- Updated dependencies [c038f83]
- Updated dependencies [71d46d6]
  - @birdybeep/claude-code@0.3.0
  - @birdybeep/codex@0.3.0
  - @birdybeep/cursor@0.3.0
  - @birdybeep/agent-core@0.3.0
  - @birdybeep/opencode@0.3.0

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
