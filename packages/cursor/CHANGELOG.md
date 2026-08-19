# @birdybeep/cursor

## 0.5.0

### Patch Changes

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

- Updated dependencies [5153f4e]
- Updated dependencies [f48eb6c]
- Updated dependencies [4d7888e]
- Updated dependencies [b9b9610]
- Updated dependencies [b9e5c57]
  - @birdybeep/agent-core@0.5.0

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

### Patch Changes

- cc9d1c4: Deliver the events Cursor sends through its Claude Code compatibility bridge. Cursor desktop reads
  `~/.claude/settings.json` and runs `birdybeep hook claude` with a Cursor payload; those fires are now
  handled by the Cursor adapter and reported as `harness: "cursor"`, `routedFrom: "claude"` instead of
  being dropped. A payload no adapter recognizes exits non-zero with a message naming the event, rather
  than exiting 0 with no output.
- Updated dependencies [6817f70]
  - @birdybeep/agent-core@0.4.0

## 0.3.0

### Minor Changes

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

- Updated dependencies [bbdbab7]
- Updated dependencies [50390db]
- Updated dependencies [6ad01d4]
- Updated dependencies [65abd2d]
- Updated dependencies [88f1dd5]
- Updated dependencies [8517fc8]
- Updated dependencies [859e150]
- Updated dependencies [c038f83]
- Updated dependencies [519f4ff]
- Updated dependencies [71d46d6]
  - @birdybeep/agent-core@0.3.0
