---
"@birdybeep/codex": patch
---

Fix a false "installed"/"trusted" Codex status (security: trust-signal correctness). The trust
marker that flips Codex from `needs_trust` to `installed` was recorded on **any** mappable, non-
skipped event — including the top-level `notify` program (`agent-turn-complete`), which Codex runs
on every turn regardless of whether the user ever trusted the `[[hooks.X]]` entries via `/hooks`.
So the first turn-complete flipped BirdyBeep to `installed`, claiming approval beeps worked, while
the security-relevant `PermissionRequest` → `approval_required` lifecycle hook was still untrusted
and silently dropped — a false "you'll be notified" promise.

Trust is now recorded only when a genuinely **trust-gated lifecycle hook** (a payload keyed by
`hook_event_name`) is processed with a `delivered` or `queued` outcome. A `notify` fire, a `skipped`
(unmappable) payload, or a `dropped` (terminally rejected) event no longer flips the marker, so
Codex keeps reporting `needs_trust` until a real hook fire proves the hooks were trusted. The
`doctor` "Codex hooks trusted" detail now explains that turn-complete beeps arrive via the ungated
`notify` program and are not proof of trust.
