# @birdybeep/agent-core

## 0.3.0

### Minor Changes

- 6ad01d4: Add the Cursor adapter (`@birdybeep/cursor`) — a new harness integration.

  Cursor reads `~/.cursor/hooks.json` (`{ "version": 1, "hooks": { "<eventName>": [ { command, timeout } ] } }`) and delivers each hook's event payload as JSON on **stdin**, so the managed command is `birdybeep hook cursor` (stdin-based, matching Claude Code). Install is non-destructive + idempotent (backs up the original, adds only BirdyBeep-managed entries, byte-for-byte reversible on uninstall) and there is **no trust/restart gate** — status is `installed` the moment the entries are written.

  Event mapping (§10.1): `sessionStart` → `session_started`; `sessionEnd{final_status:"completed"}` → `agent_completed`; `sessionEnd{other}` → `session_ended`; `stop` → `agent_completed`; `beforeShellExecution` → `approval_required`; `preToolUse` → `tool_started`; `postToolUse` → `tool_finished`; `subagentStart`/`subagentStop` → `subagent_started`/`subagent_completed`; anything else → skipped.

  **CLI-fires-a-subset caveat**: headless `cursor-agent -p` fires ONLY `sessionStart` + `sessionEnd` (a version-dependent subset — the IDE fires the full documented set). That is why a completed `sessionEnd` maps to `agent_completed`: it is the only completion signal CLI users ever get, so it must produce the "your agent finished" beep. We register the full documented event set anyway so IDE users are covered.

  **Privacy**: Cursor payloads carry `user_email` (PII) and `transcript_path` (a local path). Both are **dropped entirely** — never copied into the event title/body/metadata/session-id/workspace. The only path touched is `workspace_roots[0]`, handed to the normalizer as `cwd` so it is hashed.

  **Cross-repo lockstep (§16.4)**: `HARNESS_IDS` in `@birdybeep/agent-core` gains `"cursor"` (appended last, preserving every existing ordinal), and the vendored schema-parity fixture is updated in lockstep. The private `@birdybeep/shared` `HARNESS_IDS` MUST add `"cursor"` before prod ingest (`POST /v1/agent-events`) will accept cursor events — the two halves move together.

### Patch Changes

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

- c038f83: Harden the local privacy layer that runs before any event leaves the machine (security fixes from the 2026-07 review):

  - **Absolute-path scrub now covers real-world path shapes (yop).** The old regex excluded spaces, `~`, and UNC shapes and required ≥2 segments, so a path like `/Users/alice/Client Work/acme/.env.production` was only partly hashed and forwarded the tail (`Work/acme/.env.production`) verbatim, and `\\server\share\...` paths were missed entirely. Paths with spaces, `~` expansions, Windows drive letters, and UNC shapes are now hashed as a whole run. Roots are boundary-anchored so ordinary slash-glued text (`and/or`, `1/2`, `TCP/IP`, `https://…`) is left untouched.
  - **Broader secret redaction; truncation is no longer treated as a backstop (zov).** Added detection for Google, Stripe, GitLab, Slack app-level, GitHub fine-grained, Anthropic, and AWS keys, PEM private-key blocks, and a generic high-entropy-token detector. Redaction is now the sole control for secrets — a secret in the first N characters is no longer relied on being trimmed away by truncation.
  - **Path hashes and the machine fingerprint are now salted (ofi).** Both used unsalted SHA-256, so low-entropy inputs (`/Users/<name>/dev/<repo>`, hostname/MAC) were reversible offline by anyone holding the stored hashes. A per-install random salt (persisted with strict perms in the user data dir, keyed via HMAC, plus a static pepper for the fingerprint) keeps hashes stable per machine — correlation and machine dedup still work — while making offline reversal infeasible without the salt, which never leaves the machine.

  Note: the machine fingerprint value changes with this release. The server dedups machine installations on this hash, so the first re-pair after upgrading registers a fresh installation rather than matching the pre-upgrade row (the sibling `birdybeep` repo's `machine_installations` correlation is affected in lockstep).

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
