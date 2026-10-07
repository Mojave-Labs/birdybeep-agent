# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

`birdybeep-agent` is the CLI (`@birdybeep/cli`) and the agent adapters (Claude Code, Codex, OpenCode, Cursor, GitHub Copilot CLI) that run inside developers' coding harnesses, normalize lifecycle events, and ship them to the BirdyBeep backend. The app/backend lives in the sibling repo **`birdybeep`**.

---

## 🪶 The Prime Directive — this is an agentic-first project

**The human is an orchestrator and the final-product tester. Nothing else.** They do not review diffs line-by-line or run your tests. **You** own the loop: design → implement → **verify against real harnesses end-to-end** → ship.

> **You must prove every change works by running it — installing into a real (sandboxed) environment and firing real harness events — not by reasoning about the code — before you close a ticket or push.** "It should work" / "the code looks right" are forbidden completion claims. Evidence before assertions.

If a step needs a credential a human controls (npm publish token, public-repo settings), it is a **HUMAN-REQUIRED** ticket — prepare everything up to it, hand off cleanly, and stop. Never fake it.

---

## 🚦 Non-negotiable: real end-to-end testing before every push

This package edits real config files in users' home directories and hooks into real coding agents. Bugs here break people's tooling. So **nothing reaches `git push` until you've run it for real.** Enforced by pre-push hook + CI; the responsibility is yours regardless.

### Adapter & CLI behavior — the core mandate
- Use the **E2E harness** (`A-TEST-HARNESS`): run every install/uninstall against an **isolated temporary `HOME`**, never your real machine. Assert generated config is exactly the BirdyBeep-managed entries, that existing config is preserved + backed up, and that **uninstall restores the original byte-for-byte**.
- **Fire real harness events.** For each adapter, feed the actual event payloads/commands the harness emits (Claude Code hooks, Codex `notify` + lifecycle hooks, OpenCode plugin events, Cursor hooks, Copilot CLI hooks) and assert the normalized BirdyBeep event is produced and **delivered** — run against the product repo's `wrangler dev` backend (`EVT-INGEST`) and confirm the event arrives and a push job is enqueued. A unit test of the mapper is necessary but **not sufficient**.
- **Snapshot tests** guard config generation and non-destructive patching for every adapter (`*-SNAPSHOT` tickets). Regenerate intentionally, never blindly.
- **`birdybeep doctor` must actually diagnose** the failure modes it claims to (missing token, untrusted Codex hooks, OpenCode needs-restart, offline queue). Test it by inducing each failure.
- Idempotency is tested: install twice → identical result; install over foreign config → preserved.

### Cross-platform
- The CLI must work on **macOS, Linux, and Windows**. CI runs the test matrix on all three (`A-CI`). Don't assume POSIX paths, `$HOME`, or a keychain — use the `agent-core` token store (OS keychain with strict-perm file fallback) and test the fallback.

### Tokens & privacy (tested invariants)
- **Never** write a durable token into a repo-local file or commit one. Tokens live in the OS keychain or a strict-perm file in the user config dir only.
- The hook path redacts/truncates payloads and hashes absolute paths **before** sending; assert no raw secrets/paths leave the machine.
- The local queue is best-effort, 24h retention, strict perms, and must **never block or slow the harness** — test the offline path and the fast-return timeout.

**Definition of "tested": the adapter/CLI E2E for what you changed ran this session against a real harness payload + a live backend, snapshots are current, and everything is green.** No merging on red; no `--no-verify`; never weaken a test to pass.

---

## 🔒 Enforcement
- **Pre-push hook** (`A-PREPUSH`) runs lint + typecheck + unit + snapshot + adapter smoke and **blocks the push** on failure.
- **CI** (`A-CI`) re-runs the full matrix and blocks merge. Never bypass.

## Jira workflow

Jira project **BIRD** is the authoritative tracker for both BirdyBeep repositories:
https://mojavelabs.atlassian.net/jira/software/projects/BIRD/boards/103

- Use `repo-birdybeep` for the app/API/web repo and `repo-birdybeep-agent` for the CLI/adapters. Cross-repo work carries both labels.
- Read the live issue, acceptance criteria, **Testing (mandatory)** section, comments, parent and blockers before starting. Assign it and move it to **In Progress**.
- Write the test, snapshot or UI flow first where practical, implement, then exercise the real running product and inspect its output.
- Use BIRD for all task tracking; do not maintain a parallel task tracker in repository files.
- Historical issue IDs resolve through `docs/jira-issue-map.csv` or their full legacy-ID label in Jira. Use BIRD keys for new references.
- Keep scope, decisions, verification evidence, blockers and follow-ups on the Jira issue. Use native parent and dependency links.
- Preserve `blocked`, `deferred` and `human-required` labels where applicable. An issue with an unresolved blocker is not ready just because it is in To Do.
- Move an issue to **Done** only after the required real-product verification succeeds and the changes are committed and pushed. Keep physical-device, production and account-dependent acceptance explicit.
- Durable engineering context belongs in repository documentation or private Jira comments; never put credentials or private infrastructure details in the public agent repo.

## Session Completion

1. File remaining work in BIRD and record blockers and verification evidence.
2. Run the quality gates and real-product checks for every changed surface.
3. Commit, integrate current remote changes, and push with the normal pre-push hook. Never bypass or weaken a gate.
4. Verify the commits are on the remote and the working tree is clean; then update the Jira issue and hand off any remaining acceptance.



## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts (`cp -f`, `mv -f`, `rm -f`, `rm -rf`, `ssh -o BatchMode=yes`, `apt-get -y`). Shell `cp`/`mv`/`rm` may be aliased to `-i` on some systems and will hang an agent forever.

## Architecture Overview

```
packages/
  agent-core/    event schema (mirrors birdybeep packages/schemas) · normalizer/redaction · 24h local queue · sender · token store · AgentAdapter interface
  cli/           @birdybeep/cli — pair · logout · unpair · status · test · doctor · agent install|uninstall · hook <harness>
  claude-code/   Claude Code adapter + hook templates      (highest-priority integration)
  codex/         Codex adapter + config templates           (one-time hook trust → needs_trust)
  opencode/      OpenCode plugin/adapter                     (restart-once to load)
  cursor/        Cursor adapter + ~/.cursor/hooks.json       (read live — no trust/restart gate)
  copilot/       GitHub Copilot CLI adapter + hook file      (read live — no trust/restart gate)
  test-harness/  internal E2E spine: temp-HOME sandbox · swappable sink · fixtures · contract asserts
examples/        generated config examples per harness
docs/            install · pairing · security · troubleshooting · adapter-development
scripts/         release.mjs · smoke-test.mjs · live-e2e-*.mjs
```

Every adapter implements the same `AgentAdapter` interface: `detect / install / uninstall / status / doctor / normalizeEvent`. The local hook command pattern is: harness hook → `birdybeep hook <harness>` → read token → normalize → redact/truncate → send (short timeout) → queue on failure → return fast. **No background daemon.**

**Cross-repo contract:** `agent-core`'s event schema must stay in lockstep with the private repo's `packages/schemas` (the source of truth). The receiving endpoint is `POST /v1/agent-events` in the `birdybeep` repo. Note any schema change on the ticket so both sides move together.

## Build & Test

```bash
pnpm install
pnpm turbo lint typecheck test       # includes adapter snapshot tests
pnpm test:e2e                        # real install into temp HOME + fire harness events (needs a backend; use birdybeep wrangler dev)
node scripts/smoke-test.mjs          # post-build smoke (install published-shape CLI, run doctor)
```

(Exact scripts firm up as `A-*` / `REL-*` tickets land; keep this current.)

## ✍️ Writing style for user-facing text

Applies to READMEs, `docs/`, npm `description` fields, CLI output, and error messages. The reader
came to get something done. Answer that, then stop.

**Never write, in any user-facing file:**
- What this repo *is* relative to the product — that it is public, open-source, MIT-licensed, auditable, "the client half", or that a separate/private repo holds the app and backend. Nobody reading the install docs needs the org chart.
- Why a design decision was made. Rationale goes on the Jira issue, not in front of users.
- Self-congratulatory framing: "deliberately", "carefully", "on purpose", "by design", "robust", "comprehensive", "seamless", "small-footprint", "first-class".
- Reassurance the reader didn't ask for ("don't worry", "it's safe", "trust and transparency are features"). State what the code does; let the reader draw conclusions.
- The same fact repeated across documents. Each fact lives in exactly one place; link to it.

**Do:**
- Lead with the command, the answer, or the concrete behavior.
- Prefer a table or list over a paragraph when the content is a set of facts.
- Keep an intro to one sentence saying what the thing does. No intro at all is usually better.
- Write privacy and security docs as specifics ("`cwd` is hashed with SHA-256; prompts are dropped"), never as claims ("we take privacy seriously").

**Code comments:** explain non-obvious *why* in one or two lines. If a comment needs a paragraph, it
belongs on the ticket, with the ticket id in the comment.

## Conventions
- Document install, uninstall, exactly what data is sent, and how tokens are stored. Installs are reversible and non-destructive.
- Keep adapter code isolated and easy to patch — harness APIs change (`§21.1`). Version docs against harness versions.
- Codex is not "installed" until the first event arrives (one-time `/hooks` trust); surface that as `needs_trust`. OpenCode needs a restart to load its plugin; surface `needs_restart`. Claude Code and Cursor read their config live (no trust/restart gate), so they report `installed` as soon as the managed entries are present.
