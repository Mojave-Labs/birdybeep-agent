# @birdybeep/cli

## 0.5.0

### Minor Changes

- b9b9610: Stop sending events that can never produce a notification.

  - `tool_started` and `tool_finished` are handled on your machine and no longer sent. On a measured
    18.45h Codex session that is 1016 of 1148 events — 88.5% of the traffic — none of which the
    backend could have notified on. They were also the bulk of the per-machine rate-limit budget, so
    a busy session could push real beeps into a 429.
  - `status` and `doctor` report those events instead: how many fired, when they started, and the
    count per type. A working install is still visibly working.
  - Every other event type is unchanged, including the ones that never beep: session start/resume/
    active/end and subagent start/stop still go, because the backend uses them for the sessions list,
    for "last seen", and to confirm Codex hook trust.
  - A `birdybeep hook` fire reports `filtered` under `--json` when it handled an event this way, and
    still exits 0.

### Patch Changes

- 65883d4: `doctor` now explains why Cursor events arrive on a machine that only installed the Claude Code
  hooks, and what installing the Cursor adapter adds.

  Cursor runs the hook commands in `~/.claude/settings.json`, so those machines get Cursor lifecycle
  events — but its bridge drops `Notification` and `PermissionRequest`, so approvals never arrive.
  When Cursor is present, BirdyBeep's Claude hooks are installed, and `~/.cursor/hooks.json` has none
  of BirdyBeep's entries, `doctor` reports `Approval beeps from Cursor` with the
  `birdybeep agent install cursor` fix. The check is silent in every other state.

- b9e5c57: Tell an unpaired machine apart from an offline one, and stop building a backlog that fires all at
  once when you pair.

  - An event sent with no machine token now reports `unpaired` instead of `queued`, and is not written
    to the queue — it could never have been delivered from there.
  - `birdybeep test` on an unpaired machine says `NOT PAIRED` and exits non-zero. It used to print
    `Offline — test event queued` on a machine that was online, and exit 0.
  - A hook fire on an unpaired machine writes a line to stderr and records the discard. `status` and
    `doctor` report how many events it has cost, when they started, and which harnesses fired them.
  - The local queue holds at most 500 entries (oldest dropped first); `status` and `doctor` report the
    drop count. Retention alone was the only bound.
  - `birdybeep pair` discards anything queued before pairing, so a first pairing does not replay old
    events, and says how many it dropped.

- Updated dependencies [5153f4e]
- Updated dependencies [f48eb6c]
- Updated dependencies [4d7888e]
- Updated dependencies [b9b9610]
- Updated dependencies [b9e5c57]
  - @birdybeep/agent-core@0.5.0
  - @birdybeep/claude-code@0.5.0
  - @birdybeep/codex@0.5.0
  - @birdybeep/copilot@0.5.0
  - @birdybeep/opencode@0.5.0
  - @birdybeep/cursor@0.5.0

## 0.4.0

### Patch Changes

- f2b9827: Register Codex's `[[hooks.Stop]]` for turn-complete and stop writing the single-slot `notify`
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

- cc9d1c4: Deliver the events Cursor sends through its Claude Code compatibility bridge. Cursor desktop reads
  `~/.claude/settings.json` and runs `birdybeep hook claude` with a Cursor payload; those fires are now
  handled by the Cursor adapter and reported as `harness: "cursor"`, `routedFrom: "claude"` instead of
  being dropped. A payload no adapter recognizes exits non-zero with a message naming the event, rather
  than exiting 0 with no output.
- Updated dependencies [f2b9827]
- Updated dependencies [cc9d1c4]
- Updated dependencies [6817f70]
  - @birdybeep/codex@0.4.0
  - @birdybeep/claude-code@0.4.0
  - @birdybeep/cursor@0.4.0
  - @birdybeep/agent-core@0.4.0
  - @birdybeep/copilot@0.4.0
  - @birdybeep/opencode@0.4.0

## 0.3.0

### Minor Changes

- 50390db: Add the GitHub Copilot CLI adapter and `copilot` harness id. The CLI installs a dedicated
  `~/.copilot/hooks/birdybeep.json`, passes each event name separately to
  `birdybeep hook copilot <event>`, and normalizes real Copilot lifecycle payloads without
  persisting raw prompts, tool arguments/results, transcript paths, error text, or subagent output.
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

- fd861d5: Document Cursor as a shipped harness and stop the `examples/` from drifting (birdybeep-agent-3d8.7).

  The Cursor adapter landed in #36 but nothing outside `packages/cursor` said so — the README, the
  install guide, the troubleshooting page, and the spec excerpt all still described a three-harness
  product, and there was no committed example of the config `birdybeep agent install cursor` writes.

  - **`examples/cursor/`** — the real `~/.cursor/hooks.json` produced by running the built CLI into a
    temp HOME (copied byte for byte, not hand-written), plus a README matching the other examples:
    which events are registered and what each maps to, the three registered-but-unmapped events, the
    30s timeout, non-destructive/backup/idempotency behavior, no-token-here, and the Cursor-specific
    privacy note (`user_email` and `transcript_path` are dropped outright).
  - **`examples/` drift guard** (`packages/cli/src/examples.test.ts`) — `examples/README.md` claimed
    the committed configs were byte-for-byte what the installers write and that CI caught any drift.
    Nothing enforced it. Now a test runs the real `birdybeep agent install <harness>` into a hermetic
    temp HOME for all four harnesses and compares against the committed file. It immediately caught
    one real rot: `examples/claude-code/settings.json` was missing the `SessionEnd` hook added in #20.
    Regenerated from the installer.
  - **Support matrix** in the README and `docs/install.md` (harness · target · status · config file ·
    extra step), with Cursor as shipped: patches `~/.cursor/hooks.json`, no trust/restart gate, and
    the headless `cursor-agent -p` caveat that only `sessionStart`/`sessionEnd` fire there.
  - **Harness support & roadmap** section in `docs/install.md` — the harnesses surveyed (snapshot
    2026-07-15) and passed over, with reasons: Windsurf (folded into Devin), Roo Code (discontinued
    2026-05-15), Continue (acquired by Cursor 2026-06-16), Gemini CLI (individual access cut
    2026-06-18, folded toward Antigravity) — plus the tier-2 bar a new adapter has to clear.
  - **Doc verification** — every documented command was re-run against the built CLI in a temp HOME
    and the quoted output corrected where it had drifted: the `pair` transcript, the `agent install`
    output (now four harnesses), `status`, the Codex `needs_trust` doctor line, plus Cursor entries in
    the `not_detected` / not-installed troubleshooting blocks. Fixed a dead `#logout` anchor in
    `docs/pairing.md`, and `birdybeep agent install --help` now names `cursor` in its summary like its
    usage line already did.

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

- fd861d5: Turn the passive `approved_by_email` notice into a blocking confirmation before `birdybeep pair`
  trusts a freshly minted machine token (birdybeep-md60 / ML-313 — defense-in-depth companion to the
  server-side 8orc-B fix).

  The backend already reports which account approved a pairing, and the CLI already printed it — but
  only _after_ it had stored the token, so a wrong-account or hijacked approval was something you
  noticed too late, if at all. The mint is now separated from the trust:

  - **The gate.** After `/v1/pair/token` returns the token and before anything is persisted, `pair`
    asks `Pair this machine to <email>? [y/N]`. Only `y`/`yes` consents; `n`, empty input, and EOF
    decline. On a decline **nothing** is written — no token in the keychain/file store, not even the
    non-secret `apiUrl` in the CLI config — and the command exits non-zero telling you the machine may
    still need revoking in the app. When the server reports no approving account (an older backend)
    the question is still asked, so there is no silent-trust hole.
  - **`--expect-email <addr>`** — pin the expected identity: pairs unattended on an exact
    (case/whitespace-insensitive) match, and **hard-fails** on a mismatch or when the server reported
    no identity to check against. A mismatched pin is not overridable by `--yes`. The same pin can be
    set once per machine as the non-secret `expectEmail` key in the CLI config (`--expect-email`
    overrides it).
  - **`--yes` / `-y`** — the blunt headless hatch: trust whichever account approved it, no prompt.
  - **Asks on whatever terminal exists — and exits when answered.** The answer is read from stdin
    when stdin is a TTY, and on
    macOS/Linux otherwise from the **controlling terminal** (`/dev/tty`) — which keeps pairing usable
    in shells that hand programs pipe-backed stdio while a human is right there. Windows has no such
    fallback on purpose: `CONIN$` opens even with no console attached and then blocks forever on read
    (measured on a windows-latest runner), so using it would turn a fast refusal into a hang. Windows
    shells that report a real TTY (PowerShell, `cmd`, Windows Terminal, VS Code) prompt normally, and
    Git Bash / MSYS users are pointed at `winpty birdybeep pair`, which makes stdin a TTY. The
    `/dev/tty` read uses a `tty.ReadStream` over an fd this code opens and closes deterministically,
    never `fs.createReadStream`: a threadpool fs read cannot be cancelled, so its `FSReqCallback`
    outlived the answer and (since the binary sets `process.exitCode` rather than calling
    `process.exit`) the CLI printed "✓ Paired …" and then hung until a keypress.
  - **Fails closed, never hangs.** Only when neither is available (a script, CI, a detached session,
    or an explicit `--non-interactive`) does `pair` refuse, printing an error that names both escape
    hatches — plus `winpty birdybeep pair` on Windows. `--json` keeps its NDJSON contract: the
    terminal line carries
    `reason: "declined" | "non_interactive" | "expected_email_mismatch" | "expected_email_unverifiable"`.
  - **Identity comparison is homoglyph-safe.** A pin must match both before _and_ after Unicode NFKC
    normalization, so a look-alike address (fullwidth letters, ligatures) can never auto-approve
    against an ASCII pin. A discrepancy is treated as a mismatch, which fails closed.
  - An unverifiable pin that came from the **config key** names the config file in its error rather
    than suggesting a `--expect-email` re-run that cannot help.

  Also adds per-command flag support to the CLI framework (`Command.options`), so `pair`'s flags are
  accepted by the dispatcher, documented in `birdybeep pair --help`, and inherited by subcommands from
  their parent group. The dispatcher matches GLOBAL flags **exactly** (only a command's own options
  accept the `--flag=value` spelling): `--json=true`, `--non-interactive=1`, `--help=x` and `-v=2` are
  usage errors, never silently passed through as positional args in the wrong mode.

  **Callers pairing headlessly must add `--expect-email <addr>` or `--yes`** — including cross-repo
  rigs that drive `birdybeep pair` from a script.

  Verified live by `scripts/live-e2e-pair-confirm.mjs`: the real built CLI against the real product
  worker (bundled by wrangler, served by Miniflare with real D1/KV/Queues/DO bindings and all
  migrations), driving the genuine `/v1/pair/start` → `/v1/pair/approve` → `/v1/pair/token` handshake
  with real accounts — decline, accept (on a real pty), `--yes`, pin match, pin mismatch (a second
  account approves), the headless fail-closed path, and piped-stdin-under-a-pty (the `/dev/tty`
  fallback). `scripts/live-e2e-pair-headless.mjs` re-asserts the non-interactive branches with real
  pipe stdio on **all three OSes** in CI, since the stdio-shape behavior is exactly what differs
  between platforms.

- 45c56cc: Direct pairing approval through the complete QR or link and label the short session code as
  display-only. The short code can no longer be mistaken for a standalone approval path.
- Updated dependencies [4b31d09]
- Updated dependencies [bbdbab7]
- Updated dependencies [56efaf7]
- Updated dependencies [120d1ee]
- Updated dependencies [50390db]
- Updated dependencies [6ad01d4]
- Updated dependencies [65abd2d]
- Updated dependencies [88f1dd5]
- Updated dependencies [8517fc8]
- Updated dependencies [859e150]
- Updated dependencies [6ad01d4]
- Updated dependencies [c038f83]
- Updated dependencies [519f4ff]
- Updated dependencies [71d46d6]
  - @birdybeep/claude-code@0.3.0
  - @birdybeep/codex@0.3.0
  - @birdybeep/opencode@0.3.0
  - @birdybeep/agent-core@0.3.0
  - @birdybeep/cursor@0.3.0
  - @birdybeep/copilot@0.3.0

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
