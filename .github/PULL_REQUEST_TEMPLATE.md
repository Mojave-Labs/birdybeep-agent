## What changed

<!-- Describe the user-visible behavior and why this is the smallest safe change. -->

## Verification

- [ ] `pnpm install --frozen-lockfile`
- [ ] `node scripts/pre-push.mjs`
- [ ] `pnpm build && pnpm check:pack`
- [ ] Install/uninstall ran in an isolated temporary `HOME` and restored existing config byte-for-byte.
- [ ] The affected real harness fired an event into a live `wrangler dev` backend; ingest and queue/push behavior were observed.
- [ ] Relevant macOS, Linux, and Windows behavior is covered.

Evidence (commands, harness/backend versions, and observed result):

<!-- Do not include tokens, prompts, notification content, tool data, or private paths. -->

## Privacy and release

- [ ] No token or secret is present in code, config, fixtures, logs, or git history.
- [ ] Raw prompts/replies, tool input/output, PII, and absolute paths are dropped or sanitized before delivery.
- [ ] Generated config snapshots/examples are current and uninstall remains reversible.
- [ ] A Changeset is included for every publishable behavior change, or this PR is docs/internal-only.
- [ ] Follow-up work is tracked in Beads; no unowned TODO was left in the patch.
