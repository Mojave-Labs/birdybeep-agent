---
"@birdybeep/agent-core": patch
"@birdybeep/codex": patch
"@birdybeep/opencode": patch
"@birdybeep/claude-code": patch
"@birdybeep/cursor": patch
"@birdybeep/copilot": patch
---

Codex beeps now say what finished, and lead with the repo

A Codex beep read "Codex finished" / "Turn complete" while the agent's own closing line was
already in the payload. It is now the body, summarized to one line — the same treatment Claude
Code beeps have always had. Both Codex surfaces are covered: the `Stop` hook and the `notify`
turn-complete.

Codex and OpenCode beeps also lead with `<repo> · <branch>`, like the other harnesses, so
parallel sessions are told apart at a glance.

Cursor and Copilot are unchanged: neither sends the agent's closing message on the events that
beep, so there is nothing to summarize.
