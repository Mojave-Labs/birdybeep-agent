---
"@birdybeep/agent-core": minor
"@birdybeep/claude-code": patch
"@birdybeep/codex": patch
"@birdybeep/copilot": patch
"@birdybeep/cursor": patch
"@birdybeep/opencode": patch
"@birdybeep/cli": minor
---

Stop sending events that can never produce a notification.

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
