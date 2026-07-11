---
"@birdybeep/cli": minor
---

Rename the `birdybeep login` command to `birdybeep pair`, matching the pairing
vocabulary used everywhere else (the `/v1/pair/*` endpoints, the mobile app's
"pair a machine" flow, and the docs). There is no `login` alias — `pair` is the
only name.

Teardown now has two equivalent names: `birdybeep unpair` (the twin of `pair`)
and `birdybeep logout` both remove the local machine token. `birdybeep status`
reports `Paired: yes/no` (JSON field `paired`) instead of the old login wording.
