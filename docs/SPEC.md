# BirdyBeep — Agent Integration Spec

> **Scope.** The integration contract: strategy, CLI surface, per-harness event mappings, the normalized event model, and what data leaves the machine and how tokens are stored. This file is the normative reference for building and auditing `birdybeep-agent`. The canonical wire schema is the runnable source of truth: `packages/schemas` in the product repo, mirrored here by `agent-core`'s `CORE-SCHEMA`.

BirdyBeep is a mobile notification layer for AI coding agents: when Claude Code, Codex, OpenCode, Cursor, or GitHub Copilot CLI needs you (approval, input, finished, idle, failed), it sends a push to your phone. Install once per machine, and supported agent sessions surface automatically as they emit lifecycle events.

---

## 1. Integration strategy (PRD §9.1)

BirdyBeep does not depend on a cross-agent hook standard — each harness exposes different config formats, event names, trust models, and plugin systems. So it ships **one** shared event schema, CLI auth/token layer, local event queue, and sender, plus **bespoke adapters** for Claude Code, Codex, OpenCode, Cursor, and GitHub Copilot CLI.

Every adapter implements the same interface:

```ts
interface AgentAdapter {
  id: "claude_code" | "codex" | "opencode" | "cursor" | "copilot";
  displayName: string;

  detect(): Promise<DetectionResult>;
  install(options: InstallOptions): Promise<InstallResult>;
  uninstall(options: UninstallOptions): Promise<UninstallResult>;
  status(): Promise<IntegrationStatus>;
  doctor(): Promise<DoctorResult>;
  normalizeEvent(input: unknown): Promise<BirdyBeepAgentEvent>;
}
```

## 2. Local command hook pattern (PRD §9.2)

Prefer this pattern for every harness — avoid embedding durable tokens directly in harness config files:

```text
Harness hook/plugin
  -> birdybeep local command (`birdybeep hook <harness>`)
      -> reads machine token securely
      -> normalizes event
      -> redacts/truncates payload
      -> sends event to BirdyBeep API with a short timeout
      -> writes to local queue on failure
      -> returns quickly
```

Benefits: tokens stay in one place; config files contain no long-lived secrets; local privacy rules run before delivery; offline events queue briefly; the backend API can evolve without changing every harness config format.

## 3. No background daemon (PRD §9.3)

There is **no** local background daemon in MVP. Local delivery behavior:

- The hook command attempts network delivery with a **short timeout**.
- On failure, the event is written to a **local queue** with **24-hour** retention.
- The queue drains opportunistically on subsequent hook invocations and relevant CLI commands (`birdybeep test`, `birdybeep status`, `birdybeep doctor`).
- The hook command must return quickly and must not noticeably slow the coding harness.

## 4. CLI commands (PRD §9.4)

```bash
birdybeep pair
birdybeep logout
birdybeep unpair
birdybeep status
birdybeep test
birdybeep doctor
birdybeep agent install all
birdybeep agent install claude
birdybeep agent install codex
birdybeep agent install opencode
birdybeep agent install cursor
birdybeep agent install copilot
birdybeep agent uninstall all
birdybeep agent uninstall claude
birdybeep agent uninstall codex
birdybeep agent uninstall opencode
birdybeep agent uninstall cursor
birdybeep agent uninstall copilot
birdybeep hook claude
birdybeep hook codex
birdybeep hook opencode
birdybeep hook cursor
birdybeep hook copilot <event-name>
```

Install behavior is **idempotent**, backs up existing config, adds only BirdyBeep-managed entries, prints changed files + any required user action, and installs at the **user/global** level (project-level is not MVP). Uninstall removes only BirdyBeep-managed entries.

## 5. Claude Code integration (PRD §9.5)

Highest-priority MVP integration. Install user-level hook config using the command hook `birdybeep hook claude`; add only BirdyBeep-managed entries; preserve + back up existing settings.

| Claude Code hook event | BirdyBeep event (§10.1) | Session status | Notify default |
|---|---|---|---|
| `SessionStart` | `session_started` / `session_resumed` | `starting` / `running` | No |
| `Notification` (`permission_prompt`) | `approval_required` | `waiting_for_approval` | Yes |
| `Notification` (`idle_prompt`) | `agent_idle` | `idle` | Yes |
| `Notification` (other) | `needs_input` | `waiting_for_input` | Yes |
| `PermissionRequest` | `approval_required` | `waiting_for_approval` | Yes |
| `Stop` | `agent_completed` | `completed` | Yes (user can disable) |
| `StopFailure` | `agent_failed` | `failed` | Yes |
| `SubagentStop` | `subagent_completed` | `running` / `completed` | No (MVP) |

> **Reconciliation note (§9.5 ↔ §10.1).** The adapter registers and maps only events
> Claude Code actually fires, to event types that already exist in §10.1 — no
> wire-contract change:
> - `PermissionRequest` and `Notification`+`permission_prompt` both surface approval;
>   both map to `approval_required` and are de-duplicated at delivery (CC-E2E confirms
>   which fires in-version).
> - `StopFailure`'s failure `error_type` is carried into event `metadata`.
> - **`SubagentStart`** is not a Claude Code hook event → not registered/mapped.
> - **`TaskCreated` / `TaskCompleted`** are **deferred for MVP**: their natural targets
>   `task_created` / `task_completed` are NOT in the §10.1 vocabulary (the PRD marks
>   Task\* "optional later"). Adding them is a coordinated wire-contract change, made in
>   the product `packages/schemas` first — not done here.
>
> **Deferred ≠ foreign.** Every event name above lives in `CLAUDE_CODE_HOOK_EVENTS`
> (`packages/claude-code/src/normalize.ts`), except the ones listed there as
> `CLAUDE_CODE_NON_HOOK_EVENTS`. A deferred-but-real event is skipped quietly; a payload
> from some other tool exits non-zero. Adding an event name here without adding it there
> turns that event into a per-fire error — a test fails if the two drift.

## 6. Codex integration (PRD §9.6, §21.2)

Launch integration with an expected **one-time hook trust** caveat. Install user-level lifecycle hooks; add only BirdyBeep-managed entries; back up existing config; print trust instructions.

| Codex surface/event | BirdyBeep event | Session effect | Notify default |
|---|---|---|---|
| `notify` (`agent-turn-complete`) | `agent_completed` | completed | Yes (user can disable) |
| `SessionStart` | `session_started` / `session_resumed` | upsert session | No |
| `PermissionRequest` | `approval_required` | waiting for approval | Yes |
| `PostToolUse` | `tool_finished` | activity update | No |
| `SubagentStart` | `subagent_started` | running | No |
| `SubagentStop` | `subagent_completed` | running/completed subtask | No |
| `Stop` | `agent_completed` | completed | Yes (user can disable) |

> **Reconciliation — verified against the current Codex source (`openai/codex`,
> `codex-rs/hooks`), not the PRD §9.6 table** (which conflated two surfaces):
> - **Two distinct surfaces.** Codex `config.toml` supports BOTH a top-level `notify`
>   program (turn-complete) AND a Claude-Code-style `[[hooks.X]]` lifecycle engine.
>   `notify` JSON arrives on **argv** (kebab-case, keyed by `type`); hook JSON arrives
>   on **stdin** (snake_case, keyed by `hook_event_name`). `birdybeep hook codex` accepts
>   either shape; `normalizeEvent` dispatches on whichever key is present.
> - **`notify` emits ONLY `agent-turn-complete`** → `agent_completed`. It never fires for
>   a needs-input/approval state, so the PRD's "`notify` → `needs_input`" mapping is
>   dropped. The approval/needs-input signal is the **`PermissionRequest` hook** →
>   `approval_required`.
> - **Trust.** `[[hooks.X]]` entries are trust-gated (by command hash) via `/hooks`;
>   `notify` is NOT trust-gated. Install therefore surfaces `needs_trust` (CX-TRUST) until
>   the first hook event proves trust was granted.
> - **Registered hooks:** `SessionStart`, `PermissionRequest`, `PostToolUse`,
>   `SubagentStart`, `SubagentStop`, `Stop`.
> - **BirdyBeep does not write `notify`** (birdybeep-agent-gcgp.2). This is the canonical
>   home for that decision; other docs state the behavior and link here. `notify` is a
>   single-valued scalar — last writer wins — so assigning it removes another tool's
>   integration; `[[hooks.X]]` is an append-only array. `Stop` carries the same
>   turn-complete signal, verified firing on both the terminal CLI and the desktop
>   app-server path against codex-cli 0.147.0-alpha (birdybeep-agent-gcgp.8), so the
>   shared slot buys nothing. Install therefore: leaves a foreign `notify` untouched and
>   reports it; and, where the slot still holds BirdyBeep's own legacy argv, **restores the
>   program the old installer displaced** from the canonical backup, clearing the slot only
>   when nothing was displaced. Migration must undo the old damage, not complete it —
>   vacating the slot would delete the third party's program from the last place it exists.
> - **Legacy `notify` is matched element-wise**, never by joining the array: joining
>   collapses argument boundaries, so a foreign value such as `["birdybeep hook", "codex"]`
>   would be misread as ours and deleted.
> - `normalizeEvent` still accepts `agent-turn-complete` payloads: configs written by an
>   older BirdyBeep carry them, and third-party `notify` programs may forward to
>   `birdybeep hook codex`. A turn producing both collapses to one beep — the dedup identity
>   (`harness:session:type:content-hash`) matches, because Codex's hook `session_id` and
>   notify `thread-id` are the same value.

Expected post-install message:

```text
Codex hooks installed.
Codex may require one-time hook trust. Open Codex and run /hooks.
After trust is granted, Codex sessions on this machine will be tracked automatically.
```

Do **not** mark Codex fully installed until a trusted **lifecycle hook** fires; surface the state as `needs_trust` until then. A turn-complete beep arriving via a `notify` program is **not** proof of trust and must not flip the state (see birdybeep-agent-qyf).

## 7. OpenCode integration (PRD §9.7)

Launch integration. Prefer an OpenCode **plugin package**; configure user-level/global plugin loading; preserve + back up config; print restart instructions if required (surface `needs_restart`).

| OpenCode event | BirdyBeep event | Session effect | Notify default |
|---|---|---|---|
| `session.created` | `session_started` | upsert session | No |
| `session.updated` | `session_active` | update session | No |
| `session.status` `{busy\|retry}` | `session_active` | update status | No |
| `session.status` `{idle}` | `agent_idle` | idle | Yes |
| `session.idle` | `agent_idle` | idle | Yes |
| `session.error` | `agent_failed` | failed | Yes |
| `permission.asked` | `approval_required` | waiting for approval | Yes |
| `tool.execute.before` | `tool_started` | activity update | No |
| `tool.execute.after` | `tool_finished` | activity update | No |
| `permission.replied` | _(dropped — see note)_ | — | — |

> **Reconciliation — verified against real `opencode` 1.18.1 event traffic (2026-07-15),
> not the PRD §9.7 table** (and re-verified after the SST→Anomaly rebrand changed the
> event names — §21.1 harness drift):
> - **The approval event is `permission.asked`**, payload `{id, sessionID, permission,
>   patterns, metadata, always, tool}` — the type discriminator is `properties.permission`
>   (e.g. `"bash"`/`"edit"`). An earlier SST SDK exposed `permission.updated` with a `type`
>   field; the current Anomaly build no longer emits it, so mapping the old name silently
>   dropped every approval beep.
> - **`permission.replied` is DROPPED, not mapped.** The PRD mapped it to a
>   `permission_replied` type that is **not in §10.1**. Inventing a wire type would break
>   lockstep, and the reply is the user's action — not an agent-attention moment — so it
>   is skipped (same precedent as the deferred Task\* events). No `permission_replied`.
> - **`tool.execute.before/after` are OpenCode NAMED HOOKS, not `event`-bus types.** The
>   plugin subscribes to the generic `event` hook for the `session.*`/`permission.*` bus
>   events and to the named `tool.execute.*` hooks, wrapping both into one
>   `{ type, properties, cwd }` envelope for `normalizeEvent` (cwd injected by the plugin,
>   since most bus events don't carry it).
> - OpenCode loads plugins only at startup (no hot-reload) → install surfaces
>   `needs_restart` until the next launch.

## 7.1. Cursor integration

Cursor is not in the original PRD §9.x lineup; it was added after the Big Five harness survey and
ships from `packages/cursor`. Install patches `~/.cursor/hooks.json` — `{ "version": 1, "hooks": {
"<event>": [ { command, timeout } ] } }` — non-destructively, adding the `"version"` scaffold only
when absent. Each hook command receives its payload as JSON on **stdin**. There is no trust gate and
no restart: Cursor reads the file live, so install reports `installed` immediately.

| Cursor event | BirdyBeep event | Session effect | Notify default |
|---|---|---|---|
| `sessionStart` | `session_started` | upsert session (status `starting`) | No |
| `sessionEnd` `{final_status:"completed"}` | `agent_completed` | completed | Yes |
| `sessionEnd` `{other}` | `session_ended` | terminal (ended) | No |
| `stop` | `agent_completed` | completed | Yes |
| `beforeShellExecution` | `approval_required` | waiting for approval | Yes |
| `preToolUse` | `tool_started` | activity update | No |
| `postToolUse` | `tool_finished` | activity update | No |
| `subagentStart` | `subagent_started` | activity update | No |
| `subagentStop` | `subagent_completed` | activity update | No |
| `postToolUseFailure` `{is_interrupt:false}` | `agent_failed` | activity update (status stays `running`) | Yes |
| `postToolUseFailure` `{is_interrupt:true}` | _(user cancelled — skipped)_ | — | — |
| `beforeSubmitPrompt` / `afterAgentResponse` | _(no §10.1 target — NOT registered)_ | — | — |

> **Verified against `cursor-agent 2026.07.09`** (headless `-p`, captured 2026-07-15 — see
> `packages/cursor/src/__fixtures__/README.md`; §21.1 harness drift applies):
> - **Headless `cursor-agent -p` fires ONLY `sessionStart` + `sessionEnd`** — no `stop`, no tool
>   hooks (a version-dependent subset; the IDE fires the full set). That is why a *completed*
>   `sessionEnd` maps to `agent_completed` rather than `session_ended`: for CLI users it is the
>   only completion signal there is.
> - **Registered events must be mapped** (birdybeep-agent-gcgp.17). `beforeSubmitPrompt` and
>   `afterAgentResponse` shipped registered with no §10.1 target, so every fire spent a hook
>   process to produce `skipped`. Both are de-registered, and install removes them from a config
>   an earlier release patched. `postToolUseFailure` was in the same state and is now mapped —
>   `failed` is one of the six notification categories, and it is the only failure signal Cursor
>   gives a hook. Its `error_message` and `tool_input` are content and are never read.
> - **Nine further steps stay unregistered.** `afterShellExecution` / `afterMCPExecution` are
>   completion echoes of gates already carried; `beforeReadFile` / `afterFileEdit` /
>   `beforeTabFileRead` / `afterTabFileEdit` / `afterAgentThought` are keystroke-scale; `preCompact`
>   and `workspaceOpen` map to nothing (and `workspaceOpen` has no session context).
> - **PRIVACY:** Cursor payloads carry `user_email` (PII) and `transcript_path` (a local path).
>   Neither is EVER copied into the normalized event — not title, body, metadata, session id, or
>   workspace. The only path touched is `workspace_roots[0]`, handed to the normalizer as `cwd` so
>   it is hashed. Prompts, commands, and tool data are not copied either.

## 7.2. GitHub Copilot CLI integration

Install the dedicated `~/.copilot/hooks/birdybeep.json` file (honoring `COPILOT_HOME`). Copilot
combines hook files, so foreign files are never merged or rewritten. The payload itself has no event
discriminator; each managed command therefore invokes `birdybeep hook copilot <event-name>` and
passes the JSON payload on stdin. No trust or restart step is required.

| Copilot event | BirdyBeep event | Session effect |
|---|---|---|
| `sessionStart` | `session_started` | starting |
| `userPromptSubmitted` | `session_active` | running |
| `preToolUse` | `tool_started` | running |
| `postToolUse` | `tool_finished` | running |
| `agentStop` | `agent_completed` | completed |
| `subagentStop` | `subagent_completed` | running |
| `errorOccurred` | `agent_failed` | failed |
| `sessionEnd` | `session_ended` | completed/failed |

The eight-event surface and shapes were captured from real Copilot CLI `1.0.70` and live-verified on
2026-08-06 with GitHub credentials absent and a loopback OpenAI-compatible BYOK provider. The same
installed hooks were live-verified again on 2026-08-07 against GitHub-hosted Copilot CLI `1.0.78`,
using an OAuth credential held only in the macOS Keychain. Raw prompts, tool arguments/results,
transcript paths, subagent responses, and error details are dropped.

## 8. Normalized event model (PRD §10.1)

```ts
type BirdyBeepEventType =
  | "session_started" | "session_resumed" | "session_active"
  | "needs_input" | "approval_required" | "agent_idle"
  | "agent_completed" | "agent_failed" | "test_failed"
  | "tool_started" | "tool_finished"
  | "subagent_started" | "subagent_completed"
  | "custom"
  | "test"; // `birdybeep test` diagnostic — notify-by-default, quota-exempt (9fh)
```

## 9. Canonical agent event payload (PRD §10.2)

```json
{
  "event_id": "evt_local_01JZ...",
  "event_type": "approval_required",
  "occurred_at": "2026-06-11T12:34:56.000Z",
  "harness": "claude_code",
  "harness_version": "1.0.0",
  "source_session_id": "native-session-id",
  "machine": { "label": "MacBook Pro", "os": "macos" },
  "workspace": { "cwd": "/Users/alex/code/birdybeep", "repo_name": "birdybeep", "branch": "main" },
  "status": "waiting_for_approval",
  "title": "Claude Code needs approval",
  "body": "birdybeep · mobile · npm test",
  "metadata": { "tool": "Bash", "command_summary": "npm test", "session_name": "billing refactor" }
}
```

> **`metadata.session_name` (birdybeep-agent-991)** — an adapter reports a human session NAME here
> when the harness has one. It rides the open `metadata` catchall, so neither schema declares it and
> no wire-schema bump is needed on either side; the exact key `session_name` is the whole contract
> (pinned as `SESSION_NAME_METADATA_KEY` in `agent-core/src/event.ts`). The server reads it to compose
> the push title when a user sets `NotificationPrefs.titleFormat = "session_name"`, and falls back to
> the adapter's own title when it is absent — so adapters may adopt it independently.
> Today only **Claude Code** sends it, from the `session_title` Claude Code puts on the `SessionStart`
> payload (set with `claude --name`, or a `/rename` from an earlier session — a MID-session `/rename`
> is never replayed to hooks, so it only takes effect from the next session). Codex and
> Cursor expose no session name at all — only opaque ids — and OpenCode's Session `title` is
> conversation-derived rather than user-given, so forwarding it would leak prompt content; those
> three send nothing. It is a name a human typed, never an id and never path-derived,
> and it is redacted/scrubbed/truncated by the normalizer exactly like the title it mirrors.

The event is sent to the BirdyBeep API (`POST /v1/agent-events`), authenticated by the machine installation token. The endpoint validates the schema, enforces a max payload size, and returns quickly. Title/body are used only for delivering the push notification — they are **not** persisted server-side by default.

## 10. Session identity (PRD §10.3) & statuses (PRD §10.4)

Session identity is keyed by:

```text
user_id + machine_installation_id + harness + source_session_id
```

If a harness has no stable source session id, the local adapter generates a best-effort id from available fields (cwd, process/session context, transcript path, time window).

```ts
type AgentSessionStatus =
  | "starting" | "running" | "waiting_for_input" | "waiting_for_approval"
  | "idle" | "completed" | "failed" | "unknown";
```

## 11. Security, privacy & what's sent (PRD §15.1–15.3)

**Pairing protocol (device-code flow; schemas mirrored from the product `packages/schemas`):**
`birdybeep pair` POSTs `/v1/pair/start` (`{ machine_label, os?, cli_version?, requested_scopes? }`)
→ bare `{ device_code, user_code, qr_payload, expires_at }`; it shows the complete `qr_payload`
plus a display-only `user_code` (the QR/link carries a short-lived approval secret, never a durable
token; the user code alone cannot approve) and polls `POST /v1/pair/token`
(`{ device_code, machine_fingerprint? }`) — a `validation_failed`/4xx means "not approved yet,
keep polling" — until `201 { machine_token, machine_id }` or the `expires_at` deadline. The token
is stored in the secure store only. `report-status` sends ONE batched
`POST /v1/integrations/status` (`{ integrations: [{ harness, status, harness_version?,
adapter_version? }] }`) and reads the server's effective status from the `{ integrations: [...] }`
response; a 401/403 (mirrored error envelope) is terminal, offline is deferred. These shapes are
mirrored field-for-field in `agent-core` (§16.4 lockstep); the LIVE pass against the product
backend is the deferred cross-repo follow-up.

**Tokens:**
- The complete pairing QR/link contains a short-lived approval secret — **never a durable token**.
- The displayed user code identifies the session but cannot approve it by itself.
- Machine tokens are shown once; the server stores only token **hashes**.
- Store the local token in the **OS keychain** where possible; otherwise a **strict-permission file** fallback.
- Tokens can be revoked + rotated from the mobile app.
- **Agent integrations must never write durable tokens into repo files.**

**What leaves the machine / is stored:**
- The hook **redacts/truncates** payloads and **hashes absolute paths** before sending.
- The backend does **not** persist notification title/body content by default — it stores metadata, hashes, delivery status, and session status.
- The push provider receives title/body only because it's required to deliver the notification.

**Local machine storage:**
- A short retry queue (≤ 24h), best-effort, with strict file permissions — not a guaranteed durable audit log. Clearable via `birdybeep doctor` / debug tooling.

## 12. Public repo requirements (PRD §16.3–16.4)

This repo (MIT) must provide: clear install + uninstall docs; security notes; an explanation of exactly what data is sent and how tokens are stored; examples of generated config; a `doctor` command; and tests for non-destructive config patching. Keep adapter code isolated and easy to patch/release — harness APIs change; version the docs against harness versions.
