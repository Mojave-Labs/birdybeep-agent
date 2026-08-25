---
"@birdybeep/agent-core": minor
"@birdybeep/cli": minor
---

Tell an abandoned phone from a phone you are actually using

`birdybeep doctor` has a new "Device check-in" row: how long ago a device on your account last
opened the BirdyBeep app. A registration outlives the app that made it — APNs will happily accept
a push for a phone whose app was deleted months ago — and until now nothing in this CLI could see
the difference.

It warns, and never fails, when no device has checked in for a fortnight: a phone left in a drawer
is not a broken account, so a ✗ from this command keeps meaning what it always meant — no beep can
arrive. A server that does not report check-ins yet, an account where no device has ever checked
in (which is every account until the phone app updates), and a check-in stamped ahead of this
machine's clock (clock skew, named as such) each say exactly that instead of being reported as a
stale device. The row reports activity and only activity: whether a beep can actually be delivered
is what the push-reachability and beep-quota rows above it answer.

`doctor --json` carries the raw check-in timestamp, and distinguishes "this server does not report
it" from "no device has ever checked in".
