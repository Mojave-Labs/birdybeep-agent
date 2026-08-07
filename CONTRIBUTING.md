# Contributing to BirdyBeep

Thanks for helping improve the public CLI and adapters. This code edits real user configuration,
handles a machine credential, and runs on every agent lifecycle event, so reproducibility and privacy
are part of correctness.

## Before opening a change

Open a GitHub issue for a bug or new harness so maintainers can confirm the scope. For a security
problem, follow [SECURITY.md](./SECURITY.md) and do not disclose it in an issue.

Use Node 20.11 or newer and pnpm 10 or newer:

```bash
pnpm install --frozen-lockfile
pnpm build
node scripts/pre-push.mjs
```

If a publishable package changes, add a user-facing Changeset with `pnpm changeset`.

## Adapter changes require real evidence

Unit and snapshot tests are necessary but not enough. Before asking for review:

1. Install and uninstall in an isolated temporary `HOME`; never test config writes against your real
   profile. Confirm foreign config is preserved, the original backup is byte-identical, a second
   install is a no-op, and uninstall leaves no managed residue.
2. Capture the payload shape from the current real harness version, redact it, and add a mapping or
   snapshot regression test. Never commit prompts, replies, tool input/output, PII, private paths, or
   credentials.
3. Fire the real harness event through the built CLI into the product's local `wrangler dev` backend.
   Confirm the normalized event was accepted and the downstream Queue behavior occurred.
4. Run the local published-shape smoke test when package boundaries change:

   ```bash
   pnpm smoke -- --skip-build
   ```

The pull-request template asks for the exact harness/backend versions and observed result. “It should
work” is not verification.

## Design constraints

- Tokens stay in the OS keychain or strict-permission fallback file. They never belong in a harness
  config, repository file, command argument, test fixture, or log.
- Hash absolute paths and drop raw user/assistant/tool content before sending.
- Installs are user-level, idempotent, non-destructive, backed up once, and fully reversible.
- Hooks always return quickly. Offline delivery queues best-effort and must never stall a harness.
- Keep the public `HARNESS_IDS` tuple in lockstep with the private product schema.
- Use `bd` for maintainer task state. External contributors can use the linked GitHub issue/PR; a
  maintainer will reconcile accepted work into Beads.

## Review expectations

Keep patches focused, preserve unrelated work, and explain contract changes explicitly. CODEOWNERS
review is required for the CLI, adapters, credential/wire code, release workflows, and security
policy. Be kind, concrete, and evidence-led in every review.
