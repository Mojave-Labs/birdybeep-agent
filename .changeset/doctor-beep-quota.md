---
"@birdybeep/agent-core": minor
"@birdybeep/cli": minor
---

Show when the backend has stopped sending your beeps

`birdybeep doctor` has a new "Beep quota" row: your plan, beeps used against the limit, and both
dates of the current period. It warns once you are close to the limit and fails when the quota is
exhausted, naming the date it resets — and, on the free plan, the upgrade that clears it sooner. A
period whose end date has already passed is reported as a backend fault rather than a reset to wait
for. A server that does not report quota gets an informational line instead of a failure.

`birdybeep test` says the same thing when a send is rejected for quota, instead of "rejected by the
backend": the counter, the plan, the period, and what clears it.

`doctor --json` carries the raw quota block.
