# @birdybeep/agent-core

## 0.8.2

### Patch Changes

- 22a559c: Allow healthy agent-event requests up to eight seconds to complete, and give managed hooks enough
  time to finish that bounded send instead of falsely queueing already-accepted events. Existing
  10-second hook installs remain safe after package-only upgrades because stdin and token lookup now
  reduce the request's remaining runtime budget. Legacy Copilot hook files also remain recognized as
  BirdyBeep-owned during upgrade and uninstall, so removing the package cannot restore a stale hook.

## 0.8.1

### Patch Changes

- d96031e: Shorten setup, pairing, diagnostic, and notification messages across the CLI and adapters. Documentation now states installation, security, and recovery behavior directly.
- 039cfa9: Warn when a quota window has stalled, expose hook queue causes, and stop promising retries when the local event queue cannot persist an event.
- 45322f3: Parse the nullable beep limit used for unlimited Plus accounts and render it as unlimited in `birdybeep doctor`.

## 0.8.0

### Minor Changes

- 2cc183a: Show when the backend has stopped sending your beeps

  `birdybeep doctor` has a new "Beep quota" row: your plan, beeps used against the limit, and both
  dates of the current period. It warns once you are close to the limit and fails when the quota is
  exhausted, naming the date it resets — and, on the free plan, the upgrade that clears it sooner. A
  period whose end date has already passed is reported as a backend fault rather than a reset to wait
  for. A server that does not report quota gets an informational line instead of a failure.

  `birdybeep test` says the same thing when a send is rejected for quota, instead of "rejected by the
  backend": the counter, the plan, the period, and what clears it.

  `doctor --json` carries the raw quota block.

- dd2bc79: Tell an abandoned phone from a phone you are actually using

  `birdybeep doctor` has a new "Device check-in" row: how long ago a device on your account last
  opened the BirdyBeep app. A registration outlives the app that made it — APNs will happily accept
  a push for a phone whose app was deleted months ago — and until now nothing in this CLI could see
  the difference.

  It warns, and never fails, when no device has checked in for a fortnight: a phone left in a drawer
  is not a broken account, so a ✗ from this command keeps meaning what it always meant — no beep can
  arrive. A server that does not report check-ins yet, an account where no device has ever checked
  in (which is every account until the phone app updates), and a check-in stamped ahead of this
  machine's clock (clock skew, named as such) each say exactly that instead of being reported as a
  stale device. The row reports activity and only activity: whether a beep can actually be delivered
  is what the push-reachability and beep-quota rows above it answer.

  `doctor --json` carries the raw check-in timestamp, and distinguishes "this server does not report
  it" from "no device has ever checked in".

### Patch Changes

- e1ef7dd: Stop `birdybeep test` reporting "Offline" for an event it just delivered

  Two separate reasons the command named the wrong cause, both seen on a machine that was online:

  - The outcome was decided before the opportunistic queue drain ran. A transient blip on the first
    POST queued the event, the drain in the same call delivered it, and the command still said the
    event was queued and offline. The outcome is now reconciled against what the drain did to that
    event — tracked by event id, not inferred from the drain counts — so it reports delivered when
    it was delivered, and a terminal rejection during the drain as rejected.
  - A throttled or erroring backend queues for retry the same way an unreachable network does, and
    every queued outcome printed the offline copy. A queued result now carries its cause
    (`transport`, `backend` or `token_store`, mirrored in `--json` as `queueCause`), and `test`
    prints a different line for each: "Offline" only when the request never reached the backend,
    and otherwise which backend answer parked it. The cause is read off the newest attempt in the
    call that actually reached the backend, so a 429 or a 500 is not relabelled "offline" when the
    drain's re-attempt of the same event fails to reach it moments later — which is common, because
    that re-attempt gets only whatever is left of the send budget.

  A 429 carrying a `quota_exceeded` envelope is still a terminal reject and still reports as
  rejected by the backend.

## 0.7.0

### Minor Changes

- 5ce9fc0: Tell you when no device can receive a beep

  `birdybeep doctor` checked this machine — token, hooks, harness builds, network — and reported
  all-green while the account had no device that could receive a push, so beeps went nowhere and
  nothing said so. It now has a "Push reachability" row that fails when no device is registered, or
  when the ones that are have not checked in for over a week, and names the fix.

  `birdybeep test` no longer promises a Beep it cannot see. It reports how many registered devices
  the push was queued for, or says plainly that nothing will arrive.

### Patch Changes

- b6dd9d6: Codex beeps now say what finished, and lead with the repo

  A Codex beep read "Codex finished" / "Turn complete" while the agent's own closing line was
  already in the payload. It is now the body, summarized to one line — the same treatment Claude
  Code beeps have always had. Both Codex surfaces are covered: the `Stop` hook and the `notify`
  turn-complete.

  Codex and OpenCode beeps also lead with `<repo> · <branch>`, like the other harnesses, so
  parallel sessions are told apart at a glance.

  Cursor and Copilot are unchanged: neither sends the agent's closing message on the events that
  beep, so there is nothing to summarize.

- 56c24e8: Queue events when the token store cannot be read, instead of reporting "not paired"

  A locked OS keychain read as "this machine has no token", so events fired while your screen was
  locked were discarded and `status`, `doctor` and `test` told a paired user to run `birdybeep pair`.

  Reading the token now distinguishes an empty store from one that will not answer:

  - Events fired while the store is unreadable are **queued** and deliver when it is readable again.
    The hook says so on stderr, and the `unpaired-events.json` record is not touched.
  - `status` reports `Paired:  unknown` with the reason, rather than `Paired:  no`.
  - `doctor`'s machine-token check names the store and gives the fix for that store — unlock the
    keychain, or repair the token file's path and permissions.
  - `birdybeep test` reports the store rather than "Offline" or "NOT PAIRED".
  - A token file that exists and fails to read is handled the same way, instead of erroring out of
    the hook — including one made unreachable by its parent directory, which previously read as
    "not paired" and discarded the event.

  With genuinely no token, events are still discarded and recorded, unchanged.

## 0.6.1

### Patch Changes

- 5202de0: Store the machine token when pairing from a terminal. `security` read its passphrase prompt from
  `/dev/tty` rather than the pipe carrying the token, so `birdybeep pair` and `birdybeep setup` ended
  in "macOS keychain did not store the machine token (read-back mismatch)" after asking for a
  password no one has.

## 0.6.0

### Patch Changes

- 80ee2ed: A hook fire that sends nothing now says so and exits non-zero, instead of exiting 0 in silence.
  That covers an empty or unparseable payload, a payload that never arrived within the stdin read
  cap, and — new for `codex`, `opencode` and `copilot` — a payload that harness never fires. Every
  normal outcome, including a real harness event BirdyBeep deliberately does not map, still exits 0.

  Cursor: a failed tool call now produces a Beep (`postToolUseFailure` → `agent_failed`); the tool's
  error text and arguments are never sent. Cancelling a running tool yourself does not beep.
  `beforeSubmitPrompt` and `afterAgentResponse` are no longer registered — they could never produce a
  Beep — and installing removes them from a hooks file an earlier version patched.

- 6a684e8: Report coverage per harness build, so a desktop app that never beeps stops looking installed

  `birdybeep doctor` and `birdybeep status` now list every installed build of each harness on its
  own row, with the version that build actually runs:

  ```
  ✓  Claude Code: terminal CLI 2.1.227 — covered — 1 event(s) from this build
  ✗  Claude Code: Claude desktop app 2.1.229 — not covered — nothing has ever fired from this
     build, while terminal CLI 2.1.227 is delivering through the same config
  ```

  A harness is not one program. The terminal CLI and the engine a desktop app spawns are separate
  installs on separate update channels, and they share one config file — so "hooks installed" was a
  single answer covering both, and a desktop app that could not run the hook command looked exactly
  like one that could.

  - Detection returns a surface list: `claude` on PATH and the builds under
    `~/Library/Application Support/Claude/claude-code`; every `codex` on PATH and the one inside
    ChatGPT.app; `cursor-agent` and Cursor.app. Versions are read from the filesystem — no engine is
    run, because a `--version` probe answers for whichever build is first on PATH.
  - Coverage is graded on events actually observed from each build, not on config presence. Those
    observations are keyed by which SURFACE fired, not by version alone — two channels can ship the
    same version, and a version the terminal CLI has upgraded away from is not evidence about a
    desktop build. A build is only reported as a gap once another build of the same harness is
    delivering and it still is not; a shadowed PATH install is never blamed for not firing, and an
    observation whose surface the harness never named settles nothing rather than picking a row.
  - Codex, Copilot and OpenCode gained the stale-launcher check Claude Code and Cursor already had.
    OpenCode's is different in kind: it reports the launcher record its plugin spawns, since a
    missing one silently falls back to a `PATH` lookup that drops events with no error.
  - `birdybeep doctor` tells a migrated Codex user that turn-complete beeps are OFF right now,
    rather than the first-install wording.

  Desktop surfaces are reported on macOS, where the layouts are known. Elsewhere the terminal rows
  are reported and no desktop path is guessed.

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

- 5153f4e: Discard events queued in the same millisecond as pairing. `birdybeep pair` drops the backlog a
  machine accumulated before it had anywhere to send; an event stamped at exactly the moment the
  token landed is now dropped with the rest of it, instead of sometimes surviving. Events queued
  after pairing still deliver.
- f48eb6c: Report which build of a harness produced each event, in `harness_version`.

  The field is part of the event contract but no adapter ever filled it, so every event said
  `(none)` — including on machines running the same harness twice from two update channels.

  - **Claude Code** reports the engine that fired the hook, read from the environment it exports.
    The terminal CLI and the desktop app's bundled engine update separately and now report
    separately.
  - **Codex** reports the `cli_version` from the session rollout the hook points at. The terminal
    CLI and the build inside ChatGPT.app share one `~/.codex/config.toml`, so this is what tells
    their events apart.
  - **Copilot CLI** reports `COPILOT_CLI_BINARY_VERSION`.
  - **Cursor** already reported `cursor_version`; unchanged.

  The version always comes from the harness that actually ran, never from a `--version` probe of
  whatever is on `PATH` — on a two-channel install that probe answers for the wrong build. A value
  that is not version-shaped is dropped rather than reported.

- 4d7888e: Fix hooks that never ran, and a Codex uninstall that deleted a user's own command

  - Copilot, OpenCode and Codex now invoke the CLI by absolute path instead of relying on the
    harness having the user's `PATH`. Copilot's PowerShell command uses the call operator and
    single-quoted paths; the OpenCode plugin spawns the path recorded at install time instead of
    searching `PATH`, which is what made its events disappear with no error.
  - `birdybeep agent install codex` now warns, prominently, when it has migrated an existing
    install: Codex trusts hooks by content, so the updated hooks are skipped until you open Codex
    and run `/hooks`. `birdybeep doctor` reports it until the hooks are trusted.
  - `birdybeep agent uninstall codex` removes only BirdyBeep's own command. A command of yours
    sharing a matcher entry with it is no longer deleted.

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

## 0.4.0

### Minor Changes

- 6817f70: Write a resolvable hook command, and Beep on Cursor MCP approval prompts.

  **Hook commands no longer rely on `PATH`.** Cursor executes hooks from its own process, which gets
  the `PATH` the OS gave the app rather than the one your shell has, so the bare `birdybeep hook …`
  command the installer used to write was not found there — the hook exited 127 (`command not found`)
  and no Beep was ever sent. This affected `~/.cursor/hooks.json` and `~/.claude/settings.json` (which
  Cursor also loads and runs the same way). Install now writes the absolute Node and absolute CLI entry
  point it is running under, which also covers the second half of the failure: the published bin's
  `#!/usr/bin/env node` shebang needs `node` on `PATH` too, so an absolute CLI path alone still exits 127. Set `BIRDYBEEP_HOOK_COMMAND` to write a different launcher.

  Because an absolute path can go stale (CLI reinstalled elsewhere, Node version switched),
  `birdybeep doctor` gained a "Hook command resolves" check that names the missing path and points at
  the repair, and `birdybeep agent install <harness>` now rewrites a drifted managed entry **in place**
  instead of appending a second one. Entries written by earlier versions are recognized and repaired,
  and `agent uninstall` removes either shape.

  **Cursor: `beforeMCPExecution` is now registered** and maps to `approval_required`. It is the same
  blocking permission gate as `beforeShellExecution`, so an MCP tool waiting on your approval now Beeps
  exactly like a shell command does. As with the shell gate, the payload's content — the tool
  arguments, the MCP server URL, and the server's launch command, which routinely carries an access
  token — is never read. Only the tool and server names ride along, in metadata.

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

### Patch Changes

- bbdbab7: Claude Code events now also report the session name as a discrete `metadata.session_name`
  field, so the BirdyBeep app can offer "lead my push titles with the session name" as a phone-side
  preference instead of the adapter deciding the title format on your behalf. Previously the name
  was only ever baked into the title string, which the server cannot take apart.

  Nothing changes in what you see today: the adapter still leads its own title with the name, so
  the default (pass-through) title format is byte-identical. Sessions you have not named send no
  such field, and a server that doesn't read it simply ignores it — no wire-schema change, the
  field rides the existing open `metadata` object.

  The name is the one Claude Code puts on the `SessionStart` payload — set with `claude --name`, or a
  `/rename` from an earlier session. A mid-session `/rename` is not replayed to hooks, so it applies
  from the next session (unchanged from sv1, which leads the title with the same value).

  Privacy is unchanged in kind: `session_name` is a name YOU typed, never a session id and never
  path-derived, and it goes through the same redact → hash-paths → truncate pipeline as the title it
  mirrors, so a path or token typed into a session name is scrubbed in both places. Secrets are now
  redacted BEFORE the adapter's 120-char cap is applied: capping first could split a token below the
  length its pattern needs to match, leaving a readable prefix on the wire (a latent sv1 defect on the
  title path, fixed here for both surfaces).

  Codex, Cursor and OpenCode send no session name: the first two expose only opaque ids, and
  OpenCode's session `title` is generated from the conversation rather than typed by the user, so
  forwarding it would push prompt content off the machine. Each adapter's source now records that
  audit result, and `docs/security.md` documents the new field.

  Verified live end to end by `scripts/live-e2e-session-name.mjs` (new): the real built CLI fires
  real Claude Code hooks into the product worker running under `wrangler dev`, and the push the
  worker puts on the wire is composed from the field the real adapter sent.

- 65abd2d: Activate the dgxd PKCE device-pairing binding from the CLI side (cross-repo lockstep with product PR #48).

  The product API already accepts an optional `code_challenge` on `POST /v1/pair/start` and, when a session was started with one, requires a matching `code_verifier` on `POST /v1/pair/token` before minting a machine token. That gate was dormant because the CLI didn't send those fields. This change turns it on:

  - **agent-core schema mirror (`pairing.ts`)** — mirrors the product's three new optional fields exactly: `pairStartRequestSchema.code_challenge` (`z.string().min(1).max(200).optional().catch(undefined)`), `pairTokenRequestSchema.code_verifier` (`z.string().min(1).optional().catch(undefined)`), and `pairTokenResponseSchema.approved_by_email` (`z.string().optional()`). Keeps the structural cross-repo guard consistent.
  - **agent-core PKCE helpers (`pkce.ts`)** — `generateCodeVerifier()` (base64url of 32 random bytes → 256-bit, URL-safe, unpadded) and `deriveCodeChallengeS256()` = `base64url(sha256(verifier))`, matching the server's `sha256Base64Url` byte-for-byte (verified against the RFC 7636 Appendix-B vector and the server's exact transform).
  - **CLI pairing flow (`pairing.ts` + `pair.ts`)** — `birdybeep pair` now generates a fresh verifier, sends its S256 challenge on `/pair/start`, keeps the verifier **in memory only** (never written to disk or the token store) for the duration of the run, and sends it on every `/pair/token` poll. The approving account (`approved_by_email`) is surfaced on success when the server reports it.

  Backward compatible both ways: the fields are optional, so an older server ignores them and the CLI still pairs; against the current server a fresh pair engages the binding, so a token can only be redeemed by the CLI that started the session.

- 88f1dd5: Security: stop exposing the durable machine token on the macOS `security` command line.
  The macOS keychain backend previously stored the token via `security add-generic-password
… -w <token>`, placing the secret in the child process's argument vector — which is
  world-readable on macOS (`ps -axo args` shows other users' args), so any co-located local
  process could scrape the token during a login/rotation write. The backend now passes `-w` as
  the final option (the prompt form) and feeds the token to `security` over stdin, so it never
  appears in the process table. The write is verified with a read-back, because a desynced
  prompt makes `security` store an empty item yet still exit 0.
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

- 859e150: Fix the local event queue growing without bound on an unpaired machine. When no machine
  token could be read, `send()` parked the event on disk and returned immediately, never
  calling `drainQueue()`. Pruning of expired entries lived only inside the queue's internal
  read pass, which is reachable via `drain()`/`size()` alone — so this was the one code path
  that grew the queue while never pruning it. An unpaired (or token-unreadable) machine
  accumulated one file per hook fire, forever, and the documented 24h retention was silently
  defeated; the failure was observed in the field as 457 queued entries whose oldest was two
  weeks past the retention window.

  `LocalEventQueue` gains an explicit `prune()`: it applies retention without sending
  anything, reusing the same readdir+parse pass a drain performs (no network, never throws),
  and returns a `DrainResult` whose `pruned` counts the entries dropped and whose `kept` is
  the on-disk depth left behind. The sender now calls it on both paths that can't reach the
  network — the no-token branch of `send()` (which previously reported `drained: undefined`)
  and `drainNow()` (which previously returned a hardcoded empty result) — so retention is
  enforced there and `doctor`/`status` can see what the pass did. Expired events are still
  dropped rather than delivered, so pruning never resurrects a stale beep, and a queue that
  survives retention still drains normally once the machine is paired. A new live-e2e
  (`scripts/live-e2e-queue-retention.mjs`) reproduces the field state — 457 back-dated
  entries — against the built binary and asserts that real unpaired `birdybeep hook claude`
  fires collapse it and keep the depth bounded.

- c038f83: Harden the local privacy layer that runs before any event leaves the machine (security fixes from the 2026-07 review):

  - **Absolute-path scrub now covers real-world path shapes (yop).** The old regex excluded spaces, `~`, and UNC shapes and required ≥2 segments, so a path like `/Users/alice/Client Work/acme/.env.production` was only partly hashed and forwarded the tail (`Work/acme/.env.production`) verbatim, and `\\server\share\...` paths were missed entirely. Paths with spaces, `~` expansions, Windows drive letters, and UNC shapes are now hashed as a whole run. Roots are boundary-anchored so ordinary slash-glued text (`and/or`, `1/2`, `TCP/IP`, `https://…`) is left untouched.
  - **Broader secret redaction; truncation is no longer treated as a backstop (zov).** Added detection for Google, Stripe, GitLab, Slack app-level, GitHub fine-grained, Anthropic, and AWS keys, PEM private-key blocks, and a generic high-entropy-token detector. Redaction is now the sole control for secrets — a secret in the first N characters is no longer relied on being trimmed away by truncation.
  - **Path hashes and the machine fingerprint are now salted (ofi).** Both used unsalted SHA-256, so low-entropy inputs (`/Users/<name>/dev/<repo>`, hostname/MAC) were reversible offline by anyone holding the stored hashes. A per-install random salt (persisted with strict perms in the user data dir, keyed via HMAC, plus a static pepper for the fingerprint) keeps hashes stable per machine — correlation and machine dedup still work — while making offline reversal infeasible without the salt, which never leaves the machine.

  Note: the machine fingerprint value changes with this release. The server dedups machine installations on this hash, so the first re-pair after upgrading registers a fresh installation rather than matching the pre-upgrade row (the sibling `birdybeep` repo's `machine_installations` correlation is affected in lockstep).

- 519f4ff: Make `birdybeep doctor`'s Cursor corrupt-`hooks.json` fix line actually actionable
  (birdybeep-agent-tu1), and correct the hook-timeout claim in the sender's comments
  (birdybeep-agent-5j6).

  - **Cursor doctor** — the "hooks.json is valid JSON" failure printed the only remediation in
    the adapter that named neither a file nor a command ("Fix or remove the malformed hooks.json,
    then re-run install"), even though this is precisely the failure the installer cannot repair
    on its own: it parses before it writes, so on a corrupt file it throws instead of healing it.
    The fix line now names the real recovery — the
    `<hooks.json>.birdybeep-backup` copy the installer left, when one exists, otherwise the
    malformed path — followed by the exact `birdybeep agent install cursor`. Verified by inducing
    the failure in temp HOMEs (with and without a backup) against the built CLI, confirming
    install genuinely fails on the corrupt file, and following the printed remedy back to a clean
    doctor. `docs/troubleshooting.md`, which listed every other harness in its malformed-config
    block but not Cursor, gained the matching entry plus the `.birdybeep-backup` recovery note.
  - **agent-core comments** — `sender.ts` justified its total send budget against "the 10s hook
    timeout the adapters install", which stopped being true when the Cursor adapter landed with a
    30s timeout. The comments are now harness-agnostic and enumerate the real values (Claude Code
    10s, Codex 10s, Cursor 30s, OpenCode in-process with no harness-imposed timeout), naming 10s as
    the tightest bound the 5s budget is sized against. No constants or behavior changed.

- 71d46d6: Security: close a Windows command-resolution hijack that could lead to silent RCE.

  The OpenCode plugin's event delivery spawned the bare name `birdybeep` with `shell: true`
  and no `cwd`, and every adapter's `detect()` probed the harness with a bare-name `execFile`
  (`codex`/`claude`/`opencode --version`). On Windows both `cmd.exe` and libuv resolve a bare
  name against the CURRENT WORKING DIRECTORY before PATH (applying PATHEXT), and these run with
  the harness's cwd = the repo the developer just opened. A hostile repo shipping
  `birdybeep.exe`/`.cmd`/`.bat` (or `codex.exe`, …) at its root could therefore get arbitrary
  code execution the moment a lifecycle event fired or `birdybeep agent install`/`doctor` ran —
  no prompt.

  Delivery and detection now resolve the target to an ABSOLUTE path via a new `agent-core`
  helper (`resolveOnPath`/`safeSpawn`/`safeExecFile`) that searches PATH only — never the cwd —
  and launch that absolute path with a trusted cwd and `windowsHide`. A Windows `.cmd`/`.bat`
  shim (which Node refuses to spawn without a shell) is run through the shell with the
  fully-qualified quoted path, so no cwd-first resolution can occur. If the CLI isn't on PATH
  the event is dropped with a one-time breadcrumb instead of falling back to a bare-name spawn.
  POSIX behavior is unchanged (its PATH search never included the cwd).

  On Windows the resolver now tries the real PATHEXT extensions (`.CMD`/`.EXE`/`.BAT`/…) and no
  longer prefers an extensionless PATH match. A standard `npm i -g` co-locates an extensionless
  `birdybeep` (a `#!/bin/sh` wrapper) with `birdybeep.cmd` in the same on-PATH directory;
  resolving the sh wrapper made it spawn without a shell, which Windows CreateProcess can't
  launch — silently dropping every OpenCode event and degrading version detection to "unknown".
  Picking the `.cmd` restores delivery on the exact platform this fix targets. On POSIX the
  resolver is now `execvp`-aware: a present-but-non-executable file earlier on PATH is skipped
  so the search continues to the real executable instead of failing with EACCES.

  The OpenCode plugin also delivers its event envelope on the CLI's STDIN reliably on Windows:
  piping the payload to a `.cmd` through `cmd.exe` did not dependably reach the batch shim's
  `node` grandchild (the bytes and their EOF were lost, dropping every event), so for a Windows
  `.cmd`/`.bat` the payload is now written to a strict-perm temp file and the shell's stdin is
  redirected from it (`… < "file"`), deleted when the child exits. POSIX and a Windows `.exe`
  still pipe straight to stdin. The CLI's "read stdin to EOF" contract is unchanged.

## 0.2.0

## 0.1.0

### Minor Changes

- 2aeeeeb: Emit a true end-of-session signal. Claude Code's `SessionEnd` hook is now registered and maps to a new non-notifying `session_ended` event type (mirrored in agent-core, in lockstep with the product wire contract), so a closed session settles terminal instead of lingering non-terminal until it ages out.

## 0.0.3

### Patch Changes

- 03f6f61: Claude Code notifications now say which session fired and what it did. The push title leads with `repo · branch` (pure-filesystem git detection, worktree- and detached-HEAD-aware, fail-soft), and the completion body is the summarized `last_assistant_message` instead of a fixed "Turn complete". Adds `detectRepoContext` to agent-core and populates `workspace.repo_name`/`branch` on events; no wire-schema change.

## 0.0.2

## 0.0.1

### Patch Changes

- 11b72f2: Add the `repository` field (with monorepo `directory`) to every published package.json, pointing at the public GitHub repo. Required for npm provenance and Trusted Publishing (OIDC) to validate the publishing repository, and it makes the "Repository" link on npmjs.com work.
- 8a385a5: Publish the agent-core and adapter packages (`@birdybeep/agent-core`, `@birdybeep/claude-code`, `@birdybeep/codex`, `@birdybeep/opencode`) to npm alongside the CLI. They are the CLI's runtime dependencies, so they now ship as public packages in the same fixed-version release.
