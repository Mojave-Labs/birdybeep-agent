---
"@birdybeep/agent-core": patch
---

Discard events queued in the same millisecond as pairing. `birdybeep pair` drops the backlog a
machine accumulated before it had anywhere to send; an event stamped at exactly the moment the
token landed is now dropped with the rest of it, instead of sometimes surviving. Events queued
after pairing still deliver.
