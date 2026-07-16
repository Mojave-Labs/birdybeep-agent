---
"@birdybeep/cli": patch
---

`birdybeep hook <harness> --json` now surfaces the backend's delivery **decision**
(`notified` / `suppressed` / `deduped`) and HTTP `status` alongside `outcome`, when a
send was attempted. The `outcome` alone (`delivered`) can't distinguish a beep that
actually fired from one the backend accepted-but-suppressed — the exact failure mode
`doctor` and delivery debugging need to see. Purely additive: fields are omitted when
no send happened (skipped/deduped-locally), so existing script consumers are unaffected.
