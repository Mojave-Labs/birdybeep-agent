---
"@birdybeep/cli": patch
---

Fix lost Codex beeps under headless `codex exec` (exec-exit reap race). When `codex exec`
finishes it fires its `notify` program at turn-complete and then reaps the notify child's
process group on exit. The BirdyBeep hook was sending in-line, so on a cold/slow backend the
send was still in flight when the group was SIGKILLed — the `agent_completed` beep was lost
before delivery _or_ the local queue-write finished. The interactive `codex` TUI stays alive,
so it never hit this; the bug was specific to the one-shot `codex exec` notify path.

The notify path now re-launches `birdybeep hook codex` **detached** (a new session via
`setsid` on POSIX / a new process group on Windows), delivering the payload on stdin, and the
notify process returns immediately. The detached worker is not in the group `codex exec`
reaps, so it outlives the harness and completes the fast send + queue. The scope is limited to
notify: Codex lifecycle `[[hooks.X]]` events arrive on stdin and fire mid-session, so they are
unchanged. If `birdybeep` can't be resolved on PATH the send falls back to running in-line, so
a best-effort delivery still happens. A new POSIX live-e2e (`scripts/live-e2e-codex-reap.mjs`)
reproduces the real process-group reap against the built binary and asserts both the fast
notify return and that the event is still delivered after the reap.
