---
"@birdybeep/agent-core": patch
---

Harden the local privacy layer that runs before any event leaves the machine (security fixes from the 2026-07 review):

- **Absolute-path scrub now covers real-world path shapes (yop).** The old regex excluded spaces, `~`, and UNC shapes and required ≥2 segments, so a path like `/Users/alice/Client Work/acme/.env.production` was only partly hashed and forwarded the tail (`Work/acme/.env.production`) verbatim, and `\\server\share\...` paths were missed entirely. Paths with spaces, `~` expansions, Windows drive letters, and UNC shapes are now hashed as a whole run. Roots are boundary-anchored so ordinary slash-glued text (`and/or`, `1/2`, `TCP/IP`, `https://…`) is left untouched.

- **Broader secret redaction; truncation is no longer treated as a backstop (zov).** Added detection for Google, Stripe, GitLab, Slack app-level, GitHub fine-grained, Anthropic, and AWS keys, PEM private-key blocks, and a generic high-entropy-token detector. Redaction is now the sole control for secrets — a secret in the first N characters is no longer relied on being trimmed away by truncation.

- **Path hashes and the machine fingerprint are now salted (ofi).** Both used unsalted SHA-256, so low-entropy inputs (`/Users/<name>/dev/<repo>`, hostname/MAC) were reversible offline by anyone holding the stored hashes. A per-install random salt (persisted with strict perms in the user data dir, keyed via HMAC, plus a static pepper for the fingerprint) keeps hashes stable per machine — correlation and machine dedup still work — while making offline reversal infeasible without the salt, which never leaves the machine.

Note: the machine fingerprint value changes with this release. The server dedups machine installations on this hash, so the first re-pair after upgrading registers a fresh installation rather than matching the pre-upgrade row (the sibling `birdybeep` repo's `machine_installations` correlation is affected in lockstep).
