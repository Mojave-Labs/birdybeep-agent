# BirdyBeep build plan — `birdybeep-agent`

_public, MIT — @birdybeep/cli + Claude Code / Codex / OpenCode adapters_

**69 beads** in this repo: 9 epics · 60 work tickets (2 human-required). This file is a human-orchestrator snapshot — **beads is the live source of truth** (`bd ready`, `bd show <id>`, `bd dep tree <id>`).

## How to drive the build (agentic-first)

You are the orchestrator and the final-product tester. Agents do everything else and must verify end-to-end before pushing (see `CLAUDE.md`).

```bash
bd ready                 # what's unblocked right now (respects the dependency graph)
bd show <id>             # full ticket: scope, acceptance, MANDATORY testing, deps, refs
bd update <id> --claim   # take it
bd close <id>            # done — only after the real E2E/UI test is green
bd list -l "phase:1"     # everything in a phase    (also: epic:<name>, area:backend|mobile|web|cli|adapter|...)
bd dep tree <epic-id>    # see an epic's children + ordering
bd list -l human-required  # the manual gates (you, not agents)
```

Work flows along the dependency graph: `bd ready` only surfaces a ticket once its prerequisites are closed. Start at Phase 1 and let the graph pull you forward. Labels on every ticket: `repo:*`, `epic:*`, `phase:N`, an area (`backend`/`mobile`/`web`/`docs`/`cli`/`adapter`/`infra`/`security`/`billing`/`testing`), and `human-required` where applicable.

## The testing mandate (non-negotiable)

Every feature ticket carries a **Testing (mandatory — agentic-first)** section. No code is pushed until the real thing is run and observed green; a pre-push hook + CI hard-block it. Rigs: **real installs into a temp `HOME`** firing actual Claude Code / Codex / OpenCode events against a live `wrangler dev` backend, on the macOS/Linux/Windows matrix, with config snapshot tests.

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
- `P2` **examples/{claude-code,codex,opencode}** (feature, phase 3)

### Release tooling  ·  `epic:a-release`  ·  4 tickets
_PRD: §16.3_

- `P2` **Build/bundle + package exports + bin** (task, phase 3)
- `P2` **Versioning (changesets)** (chore, phase 3)
- `P2` **scripts/release.ts** (task, phase 3)
- `P2` **scripts/smoke-test.ts** (task, phase 3)

### Manual — HUMAN REQUIRED (publish & repo)  ·  `epic:human-agent`  ·  2 tickets
_PRD: §16.3_

- `P2` **[HUMAN] npm org @birdybeep + publish tokens + first publish** (chore, phase 3) — 🧑 HUMAN
- `P2` **[HUMAN] Public repo settings + CI secrets + protection** (chore, phase 3) — 🧑 HUMAN

## 🧑 Human-required gates (you, not agents) — left until the end

Agents prepare everything up to these; a human performs the real-account / secret / billing / store / production action. They are wired late in the dependency graph.

- **[HUMAN] npm org @birdybeep + publish tokens + first publish** — Create npm org @birdybeep; publish tokens; first publish of @birdybeep/cli + packages. Agent prepares release.ts; human runs with credentials.
- **[HUMAN] Public repo settings + CI secrets + protection** — Configure public GitHub repo: branch protection, CODEOWNERS, issue/PR templates, CI secrets (staging API URL/token for E2E).
