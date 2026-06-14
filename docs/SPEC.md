# BirdyBeep — Agent Integration Spec

> **Scope & provenance.** This is a **public excerpt** of BirdyBeep's product PRD, limited to the parts that describe what the open-source CLI and agent adapters in this repo actually do — the integration strategy, the CLI surface, the per-harness event mappings, the normalized event model, and exactly what data leaves your machine and how tokens are stored. Business details (pricing, metrics, roadmap, backend internals) live in the private product repo and are intentionally not reproduced here. The mobile app's design system does not apply to this repo (this is a headless CLI).
>
> This file is the normative reference for building and auditing the code in `birdybeep-agent`. The canonical wire schema is the runnable source of truth: the product repo's `packages/schemas` (mirrored here by `agent-core`'s `CORE-SCHEMA`).

BirdyBeep is a mobile notification layer for AI coding agents: when Claude Code, Codex, or OpenCode needs you (approval, input, finished, idle, failed), it sends a push to your phone. This repo is the part that runs in your dev environment — install once per machine, and supported agent sessions surface automatically as they emit lifecycle events.

---

## 1. Integration strategy (PRD §9.1)

BirdyBeep does not depend on a cross-agent hook standard — each harness exposes different config formats, event names, trust models, and plugin systems. So it ships **one** shared event schema, CLI auth/token layer, local event queue, and sender, plus **bespoke adapters** for Claude Code, Codex, and OpenCode.

Every adapter implements the same interface:

```ts
interface AgentAdapter {
  id: "claude_code" | "codex" | "opencode";
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
birdybeep login
birdybeep logout
birdybeep status
birdybeep test
birdybeep doctor
birdybeep agent install all
birdybeep agent install claude
birdybeep agent install codex
birdybeep agent install opencode
birdybeep agent uninstall all
birdybeep agent uninstall claude
birdybeep agent uninstall codex
birdybeep agent uninstall opencode
birdybeep hook claude
birdybeep hook codex
birdybeep hook opencode
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

## 6. Codex integration (PRD §9.6, §21.2)

Launch integration with an expected **one-time hook trust** caveat. Install user-level notify command + lifecycle hooks where supported; add only BirdyBeep-managed entries; back up existing config; print trust instructions.

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
>   `SubagentStart`, `SubagentStop`. The `Stop` hook is intentionally NOT registered
>   (`notify` already covers turn-complete; registering both double-fires) — but
>   `normalizeEvent` still maps a `Stop` payload to `agent_completed` if one arrives.

Expected post-install message:

```text
Codex hooks installed.
Codex may require one-time hook trust. Open Codex and run /hooks.
After trust is granted, Codex sessions on this machine will be tracked automatically.
```

Do **not** mark Codex fully installed until the first event arrives; surface the state as `needs_trust` until then.

## 7. OpenCode integration (PRD §9.7)

Launch integration. Prefer an OpenCode **plugin package**; configure user-level/global plugin loading; preserve + back up config; print restart instructions if required (surface `needs_restart`).

| OpenCode event | BirdyBeep event | Session effect | Notify default |
|---|---|---|---|
| `session.created` | `session_started` | upsert session | No |
| `session.updated` | `session_active` | update session | No |
| `session.status` | status-specific | update status | Depends |
| `session.idle` | `agent_idle` | idle | Yes |
| `session.error` | `agent_failed` | failed | Yes |
| `permission.asked` | `approval_required` | waiting for approval | Yes |
| `permission.replied` | `permission_replied` | update approval state | No |
| `tool.execute.before` | `tool_started` | activity update | No |
| `tool.execute.after` | `tool_finished` | activity update | No |

## 8. Normalized event model (PRD §10.1)

```ts
type BirdyBeepEventType =
  | "session_started" | "session_resumed" | "session_active"
  | "needs_input" | "approval_required" | "agent_idle"
  | "agent_completed" | "agent_failed" | "test_failed"
  | "tool_started" | "tool_finished"
  | "subagent_started" | "subagent_completed"
  | "custom";
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
  "metadata": { "tool": "Bash", "command_summary": "npm test" }
}
```

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

**Tokens:**
- The pairing QR contains only short-lived pairing info — **never a durable token**.
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
