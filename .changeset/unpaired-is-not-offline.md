---
"@birdybeep/agent-core": patch
"@birdybeep/codex": patch
"@birdybeep/cli": patch
---

Tell an unpaired machine apart from an offline one, and stop building a backlog that fires all at
once when you pair.

- An event sent with no machine token now reports `unpaired` instead of `queued`, and is not written
  to the queue — it could never have been delivered from there.
- `birdybeep test` on an unpaired machine says `NOT PAIRED` and exits non-zero. It used to print
  `Offline — test event queued` on a machine that was online, and exit 0.
- A hook fire on an unpaired machine writes a line to stderr and records the discard. `status` and
  `doctor` report how many events it has cost, when they started, and which harnesses fired them.
- The local queue holds at most 500 entries (oldest dropped first); `status` and `doctor` report the
  drop count. Retention alone was the only bound.
- `birdybeep pair` discards anything queued before pairing, so a first pairing does not replay old
  events, and says how many it dropped.
