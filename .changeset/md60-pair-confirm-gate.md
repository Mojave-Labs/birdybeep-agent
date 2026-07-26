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
- **Asks on whatever terminal exists.** The answer is read from stdin when stdin is a TTY, and on
  macOS/Linux otherwise from the **controlling terminal** (`/dev/tty`) — which keeps pairing usable
  in shells that hand programs pipe-backed stdio while a human is right there. Windows has no such
  fallback on purpose: `CONIN$` opens even with no console attached and then blocks forever on read
  (measured on a windows-latest runner), so using it would turn a fast refusal into a hang. Windows
  shells that report a real TTY (PowerShell, `cmd`, Windows Terminal, VS Code) prompt normally, and
  Git Bash / MSYS users are pointed at `winpty birdybeep pair`, which makes stdin a TTY.
- **Fails closed, never hangs.** Only when neither is available (a script, CI, a detached session,
  or an explicit `--non-interactive`) does `pair` refuse, printing an error that names both escape
  hatches — plus `winpty birdybeep pair` on Windows. `--json` keeps its NDJSON contract: the
  terminal line carries
  `reason: "declined" | "non_interactive" | "expected_email_mismatch" | "expected_email_unverifiable"`.
- **Identity comparison is homoglyph-safe.** A pin must match both before _and_ after Unicode NFKC
  normalization, so a look-alike address (fullwidth letters, ligatures) can never auto-approve
  against an ASCII pin. A discrepancy is treated as a mismatch, which fails closed.
- An unverifiable pin that came from the **config key** names the config file in its error rather
  than suggesting a `--expect-email` re-run that cannot help.

Also adds per-command flag support to the CLI framework (`Command.options`), so `pair`'s flags are
accepted by the dispatcher, documented in `birdybeep pair --help`, and inherited by subcommands from
their parent group. The dispatcher matches GLOBAL flags **exactly** (only a command's own options
accept the `--flag=value` spelling): `--json=true`, `--non-interactive=1`, `--help=x` and `-v=2` are
usage errors, never silently passed through as positional args in the wrong mode.

**Callers pairing headlessly must add `--expect-email <addr>` or `--yes`** — including cross-repo
rigs that drive `birdybeep pair` from a script.

Verified live by `scripts/live-e2e-pair-confirm.mjs`: the real built CLI against the real product
worker (bundled by wrangler, served by Miniflare with real D1/KV/Queues/DO bindings and all
migrations), driving the genuine `/v1/pair/start` → `/v1/pair/approve` → `/v1/pair/token` handshake
with real accounts — decline, accept (on a real pty), `--yes`, pin match, pin mismatch (a second
account approves), the headless fail-closed path, and piped-stdin-under-a-pty (the `/dev/tty`
fallback). `scripts/live-e2e-pair-headless.mjs` re-asserts the non-interactive branches with real
pipe stdio on **all three OSes** in CI, since the stdio-shape behavior is exactly what differs
between platforms.
