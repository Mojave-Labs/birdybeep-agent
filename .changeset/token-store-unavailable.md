---
"@birdybeep/agent-core": patch
"@birdybeep/claude-code": patch
"@birdybeep/codex": patch
"@birdybeep/copilot": patch
"@birdybeep/cursor": patch
"@birdybeep/opencode": patch
"@birdybeep/cli": patch
---

Queue events when the token store cannot be read, instead of reporting "not paired"

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
