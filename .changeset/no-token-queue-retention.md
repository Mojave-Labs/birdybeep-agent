---
"@birdybeep/agent-core": patch
---

Fix the local event queue growing without bound on an unpaired machine. When no machine
token could be read, `send()` parked the event on disk and returned immediately, never
calling `drainQueue()`. Pruning of expired entries lived only inside the queue's internal
read pass, which is reachable via `drain()`/`size()` alone — so this was the one code path
that grew the queue while never pruning it. An unpaired (or token-unreadable) machine
accumulated one file per hook fire, forever, and the documented 24h retention was silently
defeated; the failure was observed in the field as 457 queued entries whose oldest was two
weeks past the retention window.

`LocalEventQueue` gains an explicit `prune()`: it applies retention without sending
anything, reusing the same readdir+parse pass a drain performs (no network, never throws),
and returns a `DrainResult` whose `pruned` counts the entries dropped and whose `kept` is
the on-disk depth left behind. The sender now calls it on both paths that can't reach the
network — the no-token branch of `send()` (which previously reported `drained: undefined`)
and `drainNow()` (which previously returned a hardcoded empty result) — so retention is
enforced there and `doctor`/`status` can see what the pass did. Expired events are still
dropped rather than delivered, so pruning never resurrects a stale beep, and a queue that
survives retention still drains normally once the machine is paired. A new live-e2e
(`scripts/live-e2e-queue-retention.mjs`) reproduces the field state — 457 back-dated
entries — against the built binary and asserts that real unpaired `birdybeep hook claude`
fires collapse it and keep the depth bounded.
