---
"@birdybeep/cli": minor
---

`birdybeep unpair` now revokes the machine server-side, not just locally. Previously both `unpair`
and `logout` only removed the local machine token, so an unpaired machine kept showing in the
BirdyBeep app. `unpair` now calls the backend's `POST /v1/machine/revoke-self` endpoint (best-effort,
authenticated with the machine token) to revoke + purge the installation server-side, then clears the
local token — so the machine disappears from the app. If the backend is unreachable it still clears
the local token and tells you to revoke the machine in the app. `logout` is unchanged: it clears the
local token only and leaves the machine paired on your account.
