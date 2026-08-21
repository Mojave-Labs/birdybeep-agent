---
"@birdybeep/agent-core": minor
"@birdybeep/cli": minor
---

Tell you when no device can receive a beep

`birdybeep doctor` checked this machine — token, hooks, harness builds, network — and reported
all-green while the account had no device that could receive a push, so beeps went nowhere and
nothing said so. It now has a "Push reachability" row that fails when no device is registered, or
when the ones that are have not checked in for over a week, and names the fix.

`birdybeep test` no longer promises a Beep it cannot see. It reports how many registered devices
the push was queued for, or says plainly that nothing will arrive.
