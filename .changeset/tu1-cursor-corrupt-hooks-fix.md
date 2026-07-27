---
"@birdybeep/cursor": patch
"@birdybeep/agent-core": patch
---

Make `birdybeep doctor`'s Cursor corrupt-`hooks.json` fix line actually actionable
(birdybeep-agent-tu1), and correct the hook-timeout claim in the sender's comments
(birdybeep-agent-5j6).

- **Cursor doctor** — the "hooks.json is valid JSON" failure printed the only remediation in
  the adapter that named neither a file nor a command ("Fix or remove the malformed hooks.json,
  then re-run install"), even though this is precisely the failure the installer cannot repair
  on its own: it parses before it writes, so on a corrupt file it throws instead of healing it.
  The fix line now names the real recovery — the
  `<hooks.json>.birdybeep-backup` copy the installer left, when one exists, otherwise the
  malformed path — followed by the exact `birdybeep agent install cursor`. Verified by inducing
  the failure in temp HOMEs (with and without a backup) against the built CLI, confirming
  install genuinely fails on the corrupt file, and following the printed remedy back to a clean
  doctor. `docs/troubleshooting.md`, which listed every other harness in its malformed-config
  block but not Cursor, gained the matching entry plus the `.birdybeep-backup` recovery note.

- **agent-core comments** — `sender.ts` justified its total send budget against "the 10s hook
  timeout the adapters install", which stopped being true when the Cursor adapter landed with a
  30s timeout. The comments are now harness-agnostic and enumerate the real values (Claude Code
  10s, Codex 10s, Cursor 30s, OpenCode in-process with no harness-imposed timeout), naming 10s as
  the tightest bound the 5s budget is sized against. No constants or behavior changed.
