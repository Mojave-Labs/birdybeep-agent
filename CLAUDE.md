# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

`birdybeep-agent` is the **public, MIT-licensed** half of BirdyBeep: the open-source CLI (`@birdybeep/cli`) and the agent adapters (Claude Code, Codex, OpenCode) that run inside developers' coding harnesses, normalize lifecycle events, and ship them to the BirdyBeep backend. It is auditable on purpose — this code runs in users' dev environments, so trust and transparency are features. The private app/backend lives in the sibling repo **`birdybeep`**.

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
- **Fire real harness events.** For each adapter, feed the actual event payloads/commands the harness emits (Claude Code hooks, Codex `notify` + lifecycle hooks, OpenCode plugin events) and assert the normalized BirdyBeep event is produced and **delivered** — run against the product repo's `wrangler dev` backend (`EVT-INGEST`) and confirm the event arrives and a push job is enqueued. A unit test of the mapper is necessary but **not sufficient**.
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

## 🔁 The work loop (every ticket)
`bd ready` → claim → read `bd show <id>` and its **Testing (mandatory)** section → write test/snapshot first → implement → **run the real install + fire real events in the sandbox** → inspect output → `bd close` → commit + push (Session Completion below; the hook re-verifies). File follow-ups with `bd create`; durable notes with `bd remember`.

## 🔗 Linear sync (human source of truth)

This repo's beads (`birdybeep-agent-*`) sync **into the same shared Birdybeep project** in Linear (team **Mojave Labs / ML**) as the product repo — Linear is the human source of truth; beads is the agent execution layer. Config: `.beads/config.yaml` (`linear.team_id`, `linear.project_id`, `id_mode: hash`) + `LINEAR_API_KEY` in env.

**Cadence — one-way-dominant; never a bare bidirectional sync:**
- Session start: `bd linear sync --pull` (scope new/changed tickets in).
- Session close: `bd linear push <id> …` for tickets you created/closed (status up). Prefer Linear on conflicts: `--prefer-linear`.
- **NEVER** run bare/unattended `bd linear sync` — bidirectional sync pulls the *whole* ML team (incl. the product repo's issues) into this repo's DB. Pull is team+project scoped only.

**Footguns:**
- **Batch create is broken** for this workspace: pushing several *new* issues at once fails ("not returned in batch create response"). Push new issues **one ID at a time**, or create in Linear and link with `bd update <id> --external-ref <url>`.
- **Active-only:** push open/active work; leave closed history in beads/Dolt (stays under Linear's plan issue cap).
- Tag new issues with the **`surface`** label (usually `agent`; also backend/web/mobile/cli) so cross-surface views work.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


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
examples/        generated config examples per harness
docs/            install · pairing · security · troubleshooting · adapter-development
scripts/         release.ts · smoke-test.ts
```

Every adapter implements the same `AgentAdapter` interface: `detect / install / uninstall / status / doctor / normalizeEvent`. The local hook command pattern is: harness hook → `birdybeep hook <harness>` → read token → normalize → redact/truncate → send (short timeout) → queue on failure → return fast. **No background daemon.**

**Cross-repo contract:** `agent-core`'s event schema must stay in lockstep with the private repo's `packages/schemas` (the source of truth). The receiving endpoint is `POST /v1/agent-events` in the `birdybeep` repo. Note any schema change on the ticket so both sides move together.

## Build & Test

```bash
pnpm install
pnpm turbo lint typecheck test       # includes adapter snapshot tests
pnpm test:e2e                        # real install into temp HOME + fire harness events (needs a backend; use birdybeep wrangler dev)
node scripts/smoke-test.ts           # post-build smoke (install published-shape CLI, run doctor)
```

(Exact scripts firm up as `A-*` / `REL-*` tickets land; keep this current.)

## Conventions
- **MIT, public, auditable.** Clear docs for install, uninstall, exactly what data is sent, and how tokens are stored. Reversible, non-destructive installs.
- Keep adapter code isolated and easy to patch — harness APIs change (`§21.1`). Version docs against harness versions.
- Codex is not "installed" until the first event arrives (one-time `/hooks` trust); surface that as `needs_trust`. OpenCode needs a restart to load its plugin; surface `needs_restart`.
