---
"@birdybeep/agent-core": patch
---

Make the cold-start guard's cutoff inclusive, so pairing discards the backlog deterministically.

Queue entries are stamped in milliseconds, so an event enqueued in the same millisecond as
pairing was ambiguous — and the previous exclusive boundary kept it. That made whether the
backlog was discarded depend on sub-millisecond timing: a same-millisecond entry survived 133
of 200 probe runs. An entry stamped exactly at the cutoff is now discarded, which fails safe
toward the storm the guard exists to prevent and costs at most one event at the instant of
pairing.
