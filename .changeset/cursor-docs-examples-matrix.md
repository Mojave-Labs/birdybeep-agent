---
"@birdybeep/cli": patch
---

Document Cursor as a shipped harness and stop the `examples/` from drifting (birdybeep-agent-3d8.7).

The Cursor adapter landed in #36 but nothing outside `packages/cursor` said so — the README, the
install guide, the troubleshooting page, and the spec excerpt all still described a three-harness
product, and there was no committed example of the config `birdybeep agent install cursor` writes.

- **`examples/cursor/`** — the real `~/.cursor/hooks.json` produced by running the built CLI into a
  temp HOME (copied byte for byte, not hand-written), plus a README matching the other examples:
  which events are registered and what each maps to, the three registered-but-unmapped events, the
  30s timeout, non-destructive/backup/idempotency behavior, no-token-here, and the Cursor-specific
  privacy note (`user_email` and `transcript_path` are dropped outright).
- **`examples/` drift guard** (`packages/cli/src/examples.test.ts`) — `examples/README.md` claimed
  the committed configs were byte-for-byte what the installers write and that CI caught any drift.
  Nothing enforced it. Now a test runs the real `birdybeep agent install <harness>` into a hermetic
  temp HOME for all four harnesses and compares against the committed file. It immediately caught
  one real rot: `examples/claude-code/settings.json` was missing the `SessionEnd` hook added in #20.
  Regenerated from the installer.
- **Support matrix** in the README and `docs/install.md` (harness · target · status · config file ·
  extra step), with Cursor as shipped: patches `~/.cursor/hooks.json`, no trust/restart gate, and
  the headless `cursor-agent -p` caveat that only `sessionStart`/`sessionEnd` fire there.
- **Harness support & roadmap** section in `docs/install.md` — the harnesses surveyed (snapshot
  2026-07-15) and passed over, with reasons: Windsurf (folded into Devin), Roo Code (discontinued
  2026-05-15), Continue (acquired by Cursor 2026-06-16), Gemini CLI (individual access cut
  2026-06-18, folded toward Antigravity) — plus the tier-2 bar a new adapter has to clear.
- **Doc verification** — every documented command was re-run against the built CLI in a temp HOME
  and the quoted output corrected where it had drifted: the `pair` transcript, the `agent install`
  output (now four harnesses), `status`, the Codex `needs_trust` doctor line, plus Cursor entries in
  the `not_detected` / not-installed troubleshooting blocks. Fixed a dead `#logout` anchor in
  `docs/pairing.md`, and `birdybeep agent install --help` now names `cursor` in its summary like its
  usage line already did.
