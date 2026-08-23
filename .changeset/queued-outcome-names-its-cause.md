---
"@birdybeep/agent-core": patch
"@birdybeep/cli": patch
---

Stop `birdybeep test` reporting "Offline" for an event it just delivered

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
  and otherwise which backend answer parked it.

A 429 carrying a `quota_exceeded` envelope is still a terminal reject and still reports as
rejected by the backend.
