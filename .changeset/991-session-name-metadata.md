---
"@birdybeep/agent-core": patch
"@birdybeep/claude-code": patch
"@birdybeep/codex": patch
"@birdybeep/cursor": patch
"@birdybeep/opencode": patch
---

Claude Code events now also report the session name as a discrete `metadata.session_name`
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
