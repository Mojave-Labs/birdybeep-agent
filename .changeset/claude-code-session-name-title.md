---
"@birdybeep/claude-code": minor
---

Claude Code push titles now lead with the session NAME when you've named a session (Claude
Code `--name` / `/rename`), so a beep tells you WHICH session wants you — e.g. `billing refactor
— Claude Code finished` instead of `myapp · main — Claude Code finished`. When no name is set,
the title is unchanged (repo · branch, then repo, then the plain action).

Because Claude Code exposes `session_title` only on the SessionStart hook (never on Stop), the
name is captured at SessionStart and cached, keyed by session id, in a strict-permission file
(dir `0700`, file `0600`) under your user data dir — never repo-local. The cache is best-effort
and fail-soft (a miss just falls back to repo · branch and never blocks or breaks the hook),
cleaned up on SessionEnd, and swept by a TTL so it can't accumulate.

Known limitation: a `/rename` performed AFTER SessionStart is not reflected in the title —
Claude Code emits no hook that replays `session_title`, so the captured name is the one from
SessionStart. Renaming before starting (or at startup) is picked up.
