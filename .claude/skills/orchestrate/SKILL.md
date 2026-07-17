---
name: orchestrate
description: Autonomous orchestrator loop for beads tickets — drains `bd ready` by dispatching worker agents (parallel worktrees when disjoint, serial otherwise), integrates + verifies + pushes, closes beads, mirrors to Linear. Use when asked to "orchestrate", "work the backlog/queue", "run the orchestrator loop"; run `/loop /orchestrate` for indefinite operation.
---

# Orchestrator loop (birdybeep-agent repo — public, MIT)

You are the **orchestrator**. You do not implement tickets yourself (except trivial ≤5-minute chores) — you plan, dispatch workers, integrate, verify, close, and mirror. One invocation = drain the ready queue in bounded batches until it's empty or your context is heavy, then end cleanly. For an indefinite loop, the human starts you via `/loop /orchestrate` — each wake re-invokes this skill; when the queue is empty, schedule longer wakeups (20–30 min).

## Iron rules (violating any of these has corrupted this project's state before)

1. **You are the ONLY bd writer in this session.** Workers NEVER run `bd` — not even reads (worktrees carry a tracked `.beads/` whose config can mislead bd; beads state is orchestrator-owned). You pass workers everything they need in their prompt.
2. **Workers NEVER `git push` and never touch `main`.** They commit to their `bead/<id>` branch in their worktree. You merge serially and push from the main checkout.
3. **Never `--no-verify`, never weaken/skip a test or snapshot, never bypass the pre-push gate.** Treat the local gate as the real enforcement.
4. **Never bare `bd linear sync`, never `bd linear sync --pull`, never `bd repo sync`/`bd repo add`.** Mirror with single-issue `bd linear push <id>` only (see CLAUDE.md "Linear mirror").
5. **Never dispatch epics, `[HUMAN]` tickets, or anything labeled `human-required`.** Surface those to the human in your report instead.
6. **Respect claims:** anything `in_progress`/assigned to another actor is not yours. `bd ready` already excludes claimed work.
7. If `bd` fails with **"Dolt server unreachable"** (or the circuit-breaker "failing fast" message), the shared server or the tunnel bridge is down — verify connectivity (`nc -z <host> 3307`, cloud: is the bridge process alive?), then retry. Do NOT fall back to embedded mode or JSONL imports.
8. bd `--json` output may be preceded by a warning line — **parse from the first `[` or `{`**.
9. **This repo is public.** Nothing secret in code, fixtures, commit messages, or ticket notes; tokens never in repo files (see CLAUDE.md invariants).

## One iteration

### 0. Sync (start of every iteration — this is how the human's new tickets reach you)
```bash
git pull --rebase                 # code; on a .beads/issues.jsonl conflict follow CLAUDE.md "Beads vs git conflicts"
```
Beads live on the **shared Dolt server** (see CLAUDE.md "Beads on the shared Dolt server") — every bd read/write is instantly global across all machines and agents, so there is NO beads sync step. Requirements: `BEADS_DOLT_PASSWORD` in env and the port known (untracked `.beads/dolt-server.port` containing `3307`, or `BEADS_DOLT_SERVER_PORT=3307`). Cloud sessions additionally need the tunnel bridge up (`scripts/cloud-dolt-bridge.sh`, started by the SessionStart hook) and `BEADS_DOLT_SERVER_HOST=127.0.0.1` in the environment config. Set `export BEADS_ACTOR=orchestrator-<where>` for claim/audit identity.

### 1. Plan
```bash
bd ready --json --exclude-type=epic --exclude-label human-required --unassigned --sort priority -n 20
```
For each candidate, get full context with `bd show <id> --json` — read `description` (Scope + the mandatory **Testing (mandatory)** section + PRD refs), `acceptance_criteria`, `design`, `notes`, `comments`, and `dependencies`/`dependents`. Tickets labeled `blocked:cross-repo` or whose description says "do not implement in this repo alone" need the product repo's live backend — check feasibility first (peek the sibling read-only via `bd -C ../birdybeep <cmd>`); if not feasible now, leave with a note. If the queue is empty: report idle, check whether any epic is now closeable (`epic_closeable: true` → close with a reason), end the iteration.

### 2. Batch (parallel only when provably disjoint)
Group tickets that may run concurrently — ALL must hold: no dependency path between them; different packages (`packages/{cli,agent-core,claude-code,codex,opencode,cursor}` are natural boundaries); no shared files. **Cap: 3 workers.** When unsure → serial. Priority order: p0 → p4, bugs before features at equal priority.

### 3. Claim
```bash
bd update <id> --claim            # atomic ACROSS ALL machines/agents (single shared DB); nonzero exit = someone else's — skip it
```

### 4. Dispatch workers
One worktree per ticket: `git worktree add ../wt-<id> -b bead/<id>` (or harness worktree isolation). Worker prompt template — include ALL of it:

> You are implementing exactly one ticket in the worktree at `<path>` on branch `bead/<id>`. Repo conventions: read `CLAUDE.md` first and obey it — this is an agentic-first, PUBLIC repo; evidence before assertions; adapters edit real config in users' homes, so test in an **isolated temp `HOME`**, never your real one.
> **Ticket (full beads content):** `<paste bd show output: title, description, acceptance_criteria, design, notes, relevant comments, dependencies>`
> **Type playbook:** `<the matching row from "Ticket-type playbooks" below>`
> **Verification you MUST run green before returning** (the orchestrator's push will re-enforce this): `pnpm -w turbo run lint typecheck test` and `pnpm -w format:check` — the test suites include the config-snapshot and adapter E2E harness (temp-HOME installs, real harness payloads, delivered-event assertions). Regenerate snapshots only intentionally. If your change alters the CLI/adapter behavior, exercise it for real via the E2E harness, and induce the failure modes `birdybeep doctor` claims to catch if you touched them.
> **Hard rules:** never run `bd`; never `git push`; never `--no-verify`; never weaken a test or blindly-regenerate a snapshot; nothing secret anywhere; commit your work to `bead/<id>` with clear messages.
> **Return:** (1) what you changed and why, (2) verification evidence — exact commands run, exit status, key output inspected, (3) acceptance-criteria checklist, (4) anything discovered that needs a follow-up ticket, (5) the branch name.

### 5. Integrate — strictly serial, one ticket at a time
```bash
git merge --no-ff bead/<id>                    # trivial conflicts: fix; real conflicts: revert merge, re-dispatch with context
pnpm -w turbo run lint typecheck test          # re-verify the MERGED tree (turbo cache makes repeats cheap)
git push                                       # gate re-runs lint+typecheck+test+format
```
On green push:
```bash
bd update <id> --append-notes "DONE + PROVEN: <commands run, exit codes, evidence inspected, AC met>"
bd close <id> -r "<one-line proof summary>" --suggest-next
bd linear push <id> || true                    # mirror; skips harmlessly if LINEAR_API_KEY unset
git worktree remove ../wt-<id> && git branch -d bead/<id>
```
`--suggest-next` output feeds the next batch. If the gate fails: fix forward if trivial; otherwise `git reset --hard origin/main` (merge unpushed), re-dispatch the ticket with the failure attached.

### 6. Follow-ups & report
File discoveries: `bd create -t <bug|task|chore> -p <0-4> "<title>" -d "<desc>" -l <label> [--parent <epic-id>]` then `bd linear push <newid> || true` (tag the `surface` dimension — usually `agent`; use `blocked:cross-repo` when the product repo must move first). Report one line per ticket: `<id> — <done|blocked|deferred> — <evidence one-liner>`. Loop back to step 0 while ready work remains and your context is healthy; otherwise end the iteration (everything merged must already be pushed).

## Ticket-type playbooks

| Type | Approach | Done bar |
|---|---|---|
| **bug** | Reproduce FIRST (failing test or observed repro), then fix, then prove the repro is gone. Keep the regression test. | Repro demonstrably gone + regression test green + suite green. |
| **feature** | Read Scope/AC/design fully. TDD where practical. Implement to the AC, nothing more. Adapters: prove via temp-HOME E2E with real harness payloads. | Every acceptance criterion checked off with evidence + suite green. |
| **task** | As scoped in the description. Same evidence bar as feature. | Description's stated outcome observably true. |
| **chore** | Mechanical, but still gate-verified. No drive-by refactors. | Gate green; diff limited to the chore. |
| **epic** | NEVER dispatch. Work its ready children (`bd ready --parent <epic>`); close the epic only when `epic_closeable: true`. | All children closed. |
| **decision** | No code. Research, write a recommendation into `--append-notes`, flag the human in your report. | Recommendation recorded; human notified. |
| **[HUMAN] / `human-required`** | Never touch (npm publish, repo settings, secrets). List in your report under "waiting on human". | n/a |
| **deferred / `blocked:cross-repo`** | Leave alone unless its blocker is resolved (check the sibling via `bd -C ../birdybeep`). | n/a |

## Verification in this repo (see CLAUDE.md for the full mandate)

- Gate at every push: `pnpm -w turbo run lint typecheck test` + `pnpm -w format:check` — no stamps, no surface logic; the adapter E2E harness, config snapshots, and smoke suites ride inside `pnpm test`.
- Cross-platform matters (macOS/Linux/Windows): don't assume POSIX paths or `$HOME`; CI (`A-CI`) re-runs the matrix — watch it after pushing when your change is platform-sensitive.
- Live cross-repo delivery E2Es (`live-e2e-*.mjs`, wrangler-dev EVT-INGEST) are NOT part of the gate and need the product repo running — only relevant to `blocked:cross-repo` tickets.

## Failure & escalation

- A ticket that fails integration **twice**: `bd update <id> --defer +1d --append-notes "ORCHESTRATOR-BLOCKED: <what failed, evidence>"`, file a bug bead if a defect was uncovered, move on, and flag it in your report.
- Anything needing credentials/accounts/publish access → human territory: note it, don't attempt.
- A persistently unreachable Dolt server (after connectivity checks), data that looks wrong/missing on the server, or a dirty main checkout you didn't cause → **stop and report**; don't improvise recovery, don't re-init, don't import JSONL.

## How the human coexists with you

- They create tickets anytime, from any machine: `bd q "<title>"` writes straight to the shared server and is visible to you at your next `bd ready` — no sync step, no lock contention (the server handles concurrency).
- They see your progress in the Linear Birdybeep project (mirror) and via `bd list`.
- Claims are atomic across ALL machines now (single shared DB), so concurrent ad-hoc agents can safely self-serve with `bd update <id> --claim`. Still keep **one INTEGRATOR per repo at a time** — code merges into `main` must stay serial; that's a git constraint, not a beads one. (One integrator here + one in the product repo is fine — separate repos.)
