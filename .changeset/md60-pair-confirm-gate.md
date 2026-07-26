---
"@birdybeep/cli": patch
---

Turn the passive `approved_by_email` notice into a blocking confirmation before `birdybeep pair`
trusts a freshly minted machine token (birdybeep-md60 / ML-313 — defense-in-depth companion to the
server-side 8orc-B fix).

The backend already reports which account approved a pairing, and the CLI already printed it — but
only _after_ it had stored the token, so a wrong-account or hijacked approval was something you
noticed too late, if at all. The mint is now separated from the trust:

- **The gate.** After `/v1/pair/token` returns the token and before anything is persisted, `pair`
  asks `Pair this machine to <email>? [y/N]`. Only `y`/`yes` consents; `n`, empty input, and EOF
  decline. On a decline **nothing** is written — no token in the keychain/file store, not even the
  non-secret `apiUrl` in the CLI config — and the command exits non-zero telling you the machine may
  still need revoking in the app. When the server reports no approving account (an older backend)
  the question is still asked, so there is no silent-trust hole.
- **`--expect-email <addr>`** — pin the expected identity: pairs unattended on an exact
  (case/whitespace-insensitive) match, and **hard-fails** on a mismatch or when the server reported
  no identity to check against. A mismatched pin is not overridable by `--yes`. The same pin can be
  set once per machine as the non-secret `expectEmail` key in the CLI config (`--expect-email`
  overrides it).
- **`--yes` / `-y`** — the blunt headless hatch: trust whichever account approved it, no prompt.
- **Fails closed, never hangs.** With no interactive stdin (a pipe, CI, `--non-interactive`) and
  neither flag, `pair` refuses and prints an error naming both hatches rather than blocking on a
  prompt no one can answer. `--json` keeps its NDJSON contract: the terminal line carries
  `reason: "declined" | "non_interactive" | "expected_email_mismatch" | "expected_email_unverifiable"`.

Also adds per-command flag support to the CLI framework (`Command.options`), so `pair`'s flags are
accepted by the dispatcher and documented in `birdybeep pair --help`.

**Callers pairing headlessly must add `--expect-email <addr>` or `--yes`** — including cross-repo
rigs that drive `birdybeep pair` from a script.

Verified live by `scripts/live-e2e-pair-confirm.mjs`: the real built CLI against the real product
worker (bundled by wrangler, served by Miniflare with real D1/KV/Queues/DO bindings and all
migrations), driving the genuine `/v1/pair/start` → `/v1/pair/approve` → `/v1/pair/token` handshake
with real accounts — decline, accept (on a real pty), `--yes`, pin match, pin mismatch (a second
account approves), and the headless fail-closed path.
