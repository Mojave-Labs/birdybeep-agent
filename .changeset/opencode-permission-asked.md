---
"@birdybeep/opencode": patch
---

Fix OpenCode approval notifications silently dropping. Verified against a real `opencode` 1.18.1 event stream, the approval-request event is **`permission.asked`** (payload `{id, sessionID, permission, patterns, metadata, always, tool}`) — the type discriminator lives in `properties.permission` (e.g. `"bash"`/`"edit"`). An earlier SST-era SDK exposed **`permission.updated`** with a `type` field; the current Anomaly build no longer emits it (§21.1 harness drift).

The adapter still forwarded and mapped the removed `permission.updated` name, so `permission.asked` was never forwarded and **every `approval_required` notification was dropped** — OpenCode users got no "the agent is waiting for you to approve" beep, one of the most important signals for a mobile notification app.

The plugin now forwards `permission.asked`, and the normalizer maps it to `approval_required` reading the type from `properties.permission`. `permission.replied` is still dropped (the user's own reply, not an agent-attention moment), and the raw command (`patterns` / `metadata.command`) is never persisted — only the safe `permission_type` discriminator flows through. Verified end-to-end against the real `opencode` binary: a live session with `permission.bash = "ask"` now delivers `approval_required` to the ingest sink.
