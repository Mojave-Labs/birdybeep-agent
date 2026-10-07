# BirdyBeep build plan — `birdybeep-agent`

_public, MIT — @birdybeep/cli + Claude Code / Codex / OpenCode / Cursor / Copilot adapters_

This file is a historical roadmap. Use the live [BIRD board](https://mojavelabs.atlassian.net/jira/software/projects/BIRD/boards/103) for current scope, ownership, status, parents and blockers. Filter by `repo-birdybeep-agent` for this repository.

## How to drive the build (agentic-first)

Read the Jira issue and its acceptance criteria, assign it and move it to In Progress, then implement and run the mandatory real-product checks in `CLAUDE.md`. Record evidence and follow-ups in Jira. Mark Done after verification and publication. Respect native dependency links and `blocked`, `deferred` and `human-required` labels.

## The testing mandate (non-negotiable)

Every feature ticket carries a **Testing (mandatory — agentic-first)** section. No code is pushed until the real thing is run and observed green; a pre-push hook + CI hard-block it. Rigs: **real installs into a temp `HOME`** firing actual Claude Code / Codex / OpenCode / Cursor / Copilot events against a live `wrangler dev` backend, on the macOS/Linux/Windows matrix, with config snapshot tests.

## Phase roadmap

### Phase 3 — Agent integrations & event pipeline

- **Agent repo scaffolding (public, MIT)** — 4 ticket(s) in this phase
- **agent-core (schema, queue, sender, tokens)** — 7 ticket(s) in this phase
- **@birdybeep/cli** — 13 ticket(s) in this phase
- **Claude Code adapter (highest priority)** — 7 ticket(s) in this phase
- **Codex adapter (one-time trust)** — 8 ticket(s) in this phase
- **OpenCode adapter (plugin)** — 8 ticket(s) in this phase
- **Public docs & examples** — 7 ticket(s) in this phase
- **Release tooling** — 4 ticket(s) in this phase
- **Manual — HUMAN REQUIRED (publish & repo)** — 2 ticket(s) in this phase

## Epics & tickets

### Agent repo scaffolding (public, MIT)  ·  `epic:a-foundation`  ·  4 tickets
_PRD: §16.3, §16.4_

- `P0` **pnpm workspaces + build (tsup)** (task, phase 3)
- `P0` **CI matrix (macOS/Ubuntu/Windows)** (chore, phase 3)
- `P0` **Pre-push hook (tests + snapshots + smoke)** (chore, phase 3)
- `P0` **E2E test harness (temp HOME + stub API)** (chore, phase 3)

### agent-core (schema, queue, sender, tokens)  ·  `epic:a-core`  ·  7 tickets
_PRD: §9.1-9.3, §10_

- `P0` **Event schema + types (mirror product schemas)** (task, phase 3)
- `P0` **Normalizer + redaction/truncation** (task, phase 3)
- `P0` **Local event queue (24h, strict perms)** (task, phase 3)
- `P0` **Sender (short timeout, queue-on-fail)** (task, phase 3)
- `P0` **Machine token storage (keychain + file fallback)** (task, phase 3)
- `P1` **Machine fingerprint + label/OS detection** (task, phase 3)
- `P0` **AgentAdapter interface** (task, phase 3)

### @birdybeep/cli  ·  `epic:a-cli`  ·  13 tickets
_PRD: §9.4, §7.2, §7.3_

- `P0` **CLI framework + global structure** (task, phase 3)
- `P0` **birdybeep pair (QR + manual)** (feature, phase 3)
- `P1` **birdybeep logout** (feature, phase 3)
- `P1` **birdybeep status** (feature, phase 3)
- `P1` **birdybeep test** (feature, phase 3)
- `P0` **birdybeep doctor** (feature, phase 3)
- `P0` **birdybeep agent install all|<harness>** (feature, phase 3)
- `P1` **birdybeep agent uninstall all|<harness>** (feature, phase 3)
- `P0` **birdybeep hook claude|codex|opencode** (feature, phase 3)
- `P1` **CLI reports integration status to backend** (feature, phase 3)
- `P2` **birdybeep queue clear (debug)** (feature, phase 3)
- `P0` **CLI end-to-end (pair→install→hook→delivered)** (feature, phase 3)
- `P1` **Offline-queue drain + non-blocking E2E** (feature, phase 3)

### Claude Code adapter (highest priority)  ·  `epic:a-claude`  ·  7 tickets
_PRD: §9.5_

- `P0` **Claude Code — detect()** (task, phase 3)
- `P0` **Claude Code — install user hooks** (feature, phase 3)
- `P0` **Claude Code — normalizeEvent mapping** (task, phase 3)
- `P1` **Claude Code — status() + doctor()** (task, phase 3)
- `P1` **Claude Code — uninstall()** (task, phase 3)
- `P0` **Claude Code — config snapshot tests** (feature, phase 3)
- `P0` **Claude Code — real hook E2E** (feature, phase 3)

### Codex adapter (one-time trust)  ·  `epic:a-codex`  ·  8 tickets
_PRD: §9.6, §21.2_

- `P1` **Codex — detect()** (task, phase 3)
- `P1` **Codex — install notify command + hooks** (feature, phase 3)
- `P1` **Codex — needs_trust handling** (feature, phase 3)
- `P1` **Codex — normalizeEvent mapping** (task, phase 3)
- `P1` **Codex — status() + doctor()** (task, phase 3)
- `P1` **Codex — uninstall()** (task, phase 3)
- `P1` **Codex — config snapshot tests** (feature, phase 3)
- `P1` **Codex — real E2E (notify + hooks)** (feature, phase 3)

### OpenCode adapter (plugin)  ·  `epic:a-opencode`  ·  8 tickets
_PRD: §9.7_

- `P1` **OpenCode — detect()** (task, phase 3)
- `P1` **OpenCode — plugin package** (feature, phase 3)
- `P1` **OpenCode — install (global plugin loading)** (feature, phase 3)
- `P1` **OpenCode — normalizeEvent mapping** (task, phase 3)
- `P1` **OpenCode — status() + doctor()** (task, phase 3)
- `P1` **OpenCode — uninstall()** (task, phase 3)
- `P1` **OpenCode — config snapshot tests** (feature, phase 3)
- `P1` **OpenCode — real E2E (plugin loaded)** (feature, phase 3)

### Public docs & examples  ·  `epic:a-docs`  ·  7 tickets
_PRD: §16.3, §16.4_

- `P1` **README (value, install, uninstall, security)** (feature, phase 3)
- `P1` **docs/install.md** (feature, phase 3)
- `P1` **docs/pairing.md** (feature, phase 3)
- `P1` **docs/security.md** (feature, phase 3)
- `P1` **docs/troubleshooting.md** (feature, phase 3)
- `P2` **docs/adapter-development.md** (feature, phase 3)
- `P2` **examples/{claude-code,codex,opencode,cursor,copilot}** (feature, phase 3)

### Release tooling  ·  `epic:a-release`  ·  4 tickets
_PRD: §16.3_

- `P2` **Build/bundle + package exports + bin** (task, phase 3)
- `P2` **Versioning (changesets)** (chore, phase 3)
- `P2` **scripts/release.mjs** (task, phase 3)
- `P2` **scripts/smoke-test.mjs** (task, phase 3)

### Manual — HUMAN REQUIRED (publish & repo)  ·  `epic:human-agent`  ·  2 tickets
_PRD: §16.3_

- `P2` **[HUMAN] npm org @birdybeep + publish tokens + first publish** (chore, phase 3) — 🧑 HUMAN
- `P2` **[HUMAN] Public repo settings + protection** (chore, phase 3) — 🧑 HUMAN

## 🧑 Human-required gates (you, not agents) — left until the end

Agents prepare everything up to these; a human performs the real-account / secret / billing / store / production action. They are wired late in the dependency graph.

- **[HUMAN] npm org @birdybeep + publish tokens + first publish** — Create npm org @birdybeep; publish tokens; first publish of @birdybeep/cli + packages. Agent prepares release.mjs; human runs with credentials.
- **[HUMAN] Public repo settings + protection** — Configure branch protection, CODEOWNERS enforcement, issue/PR templates, and private vulnerability reporting.
