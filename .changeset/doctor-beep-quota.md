---
"@birdybeep/agent-core": minor
"@birdybeep/cli": minor
---

Show when the backend has stopped sending your beeps

A quota block was invisible. The backend accepts an event (202) and rejects it afterwards, at the
quota stage, so `birdybeep doctor` printed all-green, the app showed the machine connected, and
the CLI reported every event delivered — while nothing was being sent. That state lasted a month
on a real account before anyone worked out why the beeps had stopped.

`doctor` now has a "Beep quota" row: plan, beeps used against the limit, and the full period
window with both dates. It FAILS when the quota is exhausted and names the reset date, or the
upgrade path. Showing both dates is deliberate — a row reading `100/100 beeps used (free plan,
period 2026-07-26 → 2026-07-27)` in August makes a stuck billing window obvious on sight, and
that is exactly the bug that hid for a month. A server that does not report quota yet gets an
informational line, never a failure.

`birdybeep test` stops saying "rejected by the backend" when the real answer is the quota: it
names the counter, the period and the date it resets.
