---
"@birdybeep/cli": patch
---

`doctor` now explains why Cursor events arrive on a machine that only installed the Claude Code
hooks, and what installing the Cursor adapter adds.

Cursor runs the hook commands in `~/.claude/settings.json`, so those machines get Cursor lifecycle
events — but its bridge drops `Notification` and `PermissionRequest`, so approvals never arrive.
When Cursor is present, BirdyBeep's Claude hooks are installed, and `~/.cursor/hooks.json` has none
of BirdyBeep's entries, `doctor` reports `Approval beeps from Cursor` with the
`birdybeep agent install cursor` fix. The check is silent in every other state.
