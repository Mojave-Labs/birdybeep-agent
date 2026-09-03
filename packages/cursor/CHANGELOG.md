# @birdybeep/cursor

## 0.8.2

### Patch Changes

- Updated dependencies [22a559c]
  - @birdybeep/agent-core@0.8.2

## 0.8.1

### Patch Changes

- d96031e: Shorten setup, pairing, diagnostic, and notification messages across the CLI and adapters. Documentation now states installation, security, and recovery behavior directly.
- Updated dependencies [d96031e]
- Updated dependencies [039cfa9]
- Updated dependencies [45322f3]
  - @birdybeep/agent-core@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [2cc183a]
- Updated dependencies [dd2bc79]
- Updated dependencies [e1ef7dd]
  - @birdybeep/agent-core@0.8.0

## 0.7.0

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

- Updated dependencies [5ce9fc0]
- Updated dependencies [b6dd9d6]
- Updated dependencies [56c24e8]
  - @birdybeep/agent-core@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [5202de0]
  - @birdybeep/agent-core@0.6.1

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

- Updated dependencies [80ee2ed]
- Updated dependencies [6a684e8]
  - @birdybeep/agent-core@0.6.0

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
