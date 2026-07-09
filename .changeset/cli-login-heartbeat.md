---
"@birdybeep/cli": patch
---

Fix `birdybeep login` hanging silently. It polled `/v1/pair/token` and treated every non-2xx response as "not approved yet", so a terminal failure (e.g. `quota_exceeded` — the agent-install cap) was masked and the CLI polled into a silent 10-minute timeout. It now surfaces terminal errors with their actionable message and exits, keeps polling only on the benign "not approved yet"/transient cases, and reprints a "still waiting — approve this machine in the BirdyBeep app…" heartbeat so the prompt is visibly alive. Copy now points at the reliable in-app scan/enter path.
