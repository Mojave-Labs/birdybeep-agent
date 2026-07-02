# Adapter development

This is the contributor guide for adding support for a **new coding harness** to BirdyBeep. You
implement one interface — `AgentAdapter` — and the `@birdybeep/cli` detects, installs, uninstalls,
checks, diagnoses, and ships events for your harness with no special-casing. Nothing in the CLI
changes when a new harness plugs in.

This repo is **MIT-licensed, public, and auditable on purpose** — it runs inside developers' dev
environments, so trust and transparency are features. Adapters edit real config files in users'
home directories and hook into real agents, so the bar is high: installs are reversible and
non-destructive, no raw secrets or absolute paths ever leave the machine, and **every adapter is
proven end-to-end against a real harness payload before it ships.**

Throughout, the **Codex adapter** (`packages/codex`) is the worked example. It is the most
interesting one because it carries a one-time hook-trust caveat — a good template for any harness
with a gating step.

---

## The `AgentAdapter` interface

Every adapter implements the same contract, defined in
[`packages/agent-core/src/adapter.ts`](../packages/agent-core/src/adapter.ts):

```ts
export interface AgentAdapter {
  /** Stable harness id (also the event `harness` value). */
  readonly id: HarnessId;
  /** Human-facing harness name, e.g. "Claude Code". */
  readonly displayName: string;

  /** Is this harness installed/usable on the machine? */
  detect(): Promise<DetectionResult>;
  /** Idempotently install BirdyBeep into the harness config (backs up first). */
  install(options?: InstallOptions): Promise<InstallResult>;
  /** Remove BirdyBeep's managed entries, restoring the original config. */
  uninstall(options?: UninstallOptions): Promise<UninstallResult>;
  /** Current integration status (§8.8). */
  status(): Promise<IntegrationStatus>;
  /** Diagnose integration health and suggest remedies. */
  doctor(): Promise<DoctorResult>;
  /** Map a raw harness payload to a redacted, validated canonical event. */
  normalizeEvent(input: unknown): Promise<BirdyBeepAgentEvent>;
}
```

A finished adapter is just an object literal that wires named functions to each member. Here is the
whole Codex adapter ([`packages/codex/src/adapter.ts`](../packages/codex/src/adapter.ts)):

```ts
import type { AgentAdapter } from "@birdybeep/agent-core";

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  detect: () => detectCodex(),
  install: (options) => installCodex(options ?? {}),
  uninstall: (options) => uninstallCodex(options ?? {}),
  status: () => codexStatus(),
  doctor: () => codexDoctor(),
  normalizeEvent: (input) => normalizeCodexEvent(input),
};
```

Keep each method in its own file (`detect.ts`, `install.ts`, `uninstall.ts`, `status.ts`,
`normalize.ts`) so the adapter stays easy to patch — harness APIs change, and you want a small blast
radius when they do.

### `id` and `displayName`

- `id: HarnessId` — the stable harness id, vendored in
  [`packages/agent-core/src/primitives.ts`](../packages/agent-core/src/primitives.ts) as
  `HARNESS_IDS` (currently `"claude_code"`, `"codex"`, `"opencode"`). It is also the `harness` value
  on every event your adapter emits. Adding a harness means adding its id to `HARNESS_IDS` — and
  because that tuple is kept in **lockstep** with the private product repo's `@birdybeep/shared`,
  flag the addition on your ticket so both sides move together (the schema-parity test fails if the
  agent side drifts).
- `displayName: string` — the human-facing name shown in CLI output, e.g. `"Codex"`.

### `detect()` → `DetectionResult`

Probe whether the harness is present. **Side-effect-free** (never writes), resolved relative to the
user's `HOME` (and any harness-specific override env var), and it must **never throw** — absence
returns a clean not-detected result so `birdybeep agent install` can skip gracefully.

```ts
export interface DetectionResult {
  detected: boolean;
  version?: string;
  /** Path to the harness config the adapter would manage, if found. */
  configPath?: string;
  detail?: string;
}
```

Codex ([`detect.ts`](../packages/codex/src/detect.ts)) considers itself present if its config dir
exists **or** a `codex` binary reports a version, and it resolves the config dir from `$CODEX_HOME`
before falling back to `~/.codex` — never a hard-coded `/Users/...` path:

```ts
export async function detectCodex(options: CodexDetectOptions = {}): Promise<DetectionResult> {
  const dirPresent = existsSync(codexConfigDir(options));
  const version = await (options.probeVersion ?? probeCodexVersion)();
  const detected = dirPresent || version !== null;
  if (!detected) {
    return { detected: false, detail: "Codex not found (…)" };
  }
  const result: DetectionResult = { detected: true, configPath: codexConfigFile(options) };
  if (version !== null) result.version = version;
  return result;
}
```

Note the injectable `probeVersion` — keeping I/O behind an option makes `detect()` testable without
shelling out. Do the same for any external call.

### `install(options?)` → `InstallResult`

Non-destructively patch the harness config so it invokes `birdybeep hook <your-harness>`. This is
the contract every adapter **MUST** honor (enforced by the shared E2E harness):

- **Idempotent** — a second install is a no-op (`changed: false`).
- **Backs up** existing config once, before the first modification.
- Adds **only BirdyBeep-managed entries** — existing user config is preserved.
- **Never writes a token** into harness config or any repo file (the hook reads it at event time).
- Reports the **files it changed**, the **backups** it wrote, and any **required user actions**.
- Honors `options.dryRun` — compute and report changes without writing anything.

```ts
export interface InstallResult {
  changed: boolean; // false when the install was a no-op (idempotent re-run)
  changedFiles: string[]; // config files created or modified
  backupFiles: string[]; // backups written before modifying pre-existing config
  requiredActions: string[]; // e.g. "trust Codex hooks", "restart OpenCode"
  status: IntegrationStatus; // installed / needs_trust / needs_restart / …
}
```

See [Non-destructive install patterns](#non-destructive-install-patterns) below for the merge,
backup, and idempotency mechanics, with Codex as the worked example.

### `uninstall(options?)` → `UninstallResult`

Remove **exactly** the entries `install` added, restoring the original config. Reversible,
non-destructive installs are a core promise of this repo. Honors `options.dryRun`.

```ts
export interface UninstallResult {
  changed: boolean;
  removedFiles: string[]; // files BirdyBeep created and removed
  restoredFiles: string[]; // files restored from backup to their pre-install contents
}
```

The bar (asserted by the E2E harness): if the user never touched the config after install,
**uninstall restores the original byte-for-byte**. If BirdyBeep created the file from scratch and
nothing else remains, the file is removed. If the user edited the config after install, surgically
strip only BirdyBeep's entries and re-serialize, preserving their edits. Codex
([`uninstall.ts`](../packages/codex/src/uninstall.ts)) implements all three paths.

### `status()` → `IntegrationStatus`

Return the current integration status **read-only** — never mutate config. The values
(from `adapter.ts`):

| `IntegrationStatus` | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `installed`         | Fully wired and working.                                       |
| `not_detected`      | The harness isn't on this machine.                             |
| `needs_restart`     | Config is written but the harness must restart to load it.     |
| `needs_trust`       | Config is written but the harness needs a one-time trust step. |
| `error`             | Misconfigured (e.g. partial install, malformed config).        |
| `revoked`           | The machine token was revoked server-side.                     |
| `unknown`           | Harness present, BirdyBeep not installed.                      |

See [The `needs_trust` / `needs_restart` pattern](#the-needs_trust--needs_restart-pattern) for how a
gated harness reports `needs_trust`/`needs_restart` until the first real event proves the gate was
cleared.

### `doctor()` → `DoctorResult`

Diagnose integration health and suggest an **actionable fix per failure**. `birdybeep doctor` calls
this for every adapter, so it must genuinely diagnose the failure modes it claims to — test it by
inducing each one.

```ts
export interface DoctorCheck {
  name: string;
  ok: boolean;
  status?: IntegrationStatus;
  detail?: string;
  remedy?: string; // suggested fix when `ok` is false
}
export interface DoctorResult {
  ok: boolean; // true only when every check passed
  checks: DoctorCheck[];
}
```

Codex's [`doctor()`](../packages/codex/src/status.ts) walks an ordered checklist — harness present?
config valid? notify + hooks installed? trust granted? config writable? machine token resolvable? —
and each failing check carries a concrete `remedy`, e.g. `"Open Codex and run /hooks to trust the
BirdyBeep hooks."` or `"Run \`birdybeep login\` to pair this machine."`

### `normalizeEvent(input)` → `BirdyBeepAgentEvent`

Map a raw harness payload to a **redacted, validated, canonical event**. This is the most
adapter-specific method and gets [its own section](#normalizeevent-mapping-harness-events).

---

## `normalizeEvent`: mapping harness events

`normalizeEvent` has two jobs:

1. **Map** the harness's native event shape to a `BirdyBeepEventType` (§10.1) plus a draft canonical
   payload.
2. **Hand that draft to the shared normalizer** in
   [`packages/agent-core/src/normalize.ts`](../packages/agent-core/src/normalize.ts), which applies
   the privacy + validation rules. You **never re-implement** those rules in an adapter.

### Step 1 — map to a `BirdyBeepEventType`

The event types are vendored in `primitives.ts` as `BIRDYBEEP_EVENT_TYPES`:

```
session_started · session_resumed · session_active · needs_input · approval_required ·
agent_idle · agent_completed · agent_failed · test_failed · tool_started · tool_finished ·
subagent_started · subagent_completed · custom · test
```

(`test` is reserved for the `birdybeep test` diagnostic — adapters never emit it.)

Session statuses (`AGENT_SESSION_STATUSES`, §10.4):

```
starting · running · waiting_for_input · waiting_for_approval · idle · completed · failed · unknown
```

Pick the closest semantic type for each harness signal. Codex
([`normalize.ts`](../packages/codex/src/normalize.ts)) maps its two real surfaces — the top-level
`notify` program (argv JSON) and lifecycle `[[hooks.X]]` entries (stdin JSON) — like this:

| Codex surface                         | `event_type`                          | `status`               |
| ------------------------------------- | ------------------------------------- | ---------------------- |
| `notify {type:"agent-turn-complete"}` | `agent_completed`                     | `completed`            |
| hook `SessionStart`                   | `session_started` / `session_resumed` | `starting` / `running` |
| hook `PermissionRequest`              | `approval_required`                   | `waiting_for_approval` |
| hook `PostToolUse`                    | `tool_finished`                       | `running`              |
| hook `SubagentStart`                  | `subagent_started`                    | `running`              |
| hook `SubagentStop`                   | `subagent_completed`                  | `running`              |

> **Verify against the live harness, not a spec table.** Codex's mapping was reconciled against the
> actual `openai/codex` source, and the comments record where reality differed from the PRD. Do the
> same: read the harness's hook/notify docs and source, fire real events, and confirm what actually
> arrives.

A single mapper case looks like this — note that only **safe discriminators** are carried into
`metadata`:

```ts
case "PermissionRequest": {
  // tool_name is a safe identifier (e.g. "Bash"); tool_input is content — never persisted.
  const tool = str(payload["tool_name"]);
  return {
    eventType: "approval_required",
    status: "waiting_for_approval",
    title: "Codex needs approval",
    body: tool ? `Approve ${tool}?` : "Approval requested",
    metadata: { tool },
  };
}
```

**Deliberately drop raw user/assistant content.** Codex never persists input messages, the
last-assistant message, or `tool_input` — only the tool name and status flow through. (OpenCode
likewise drops tool args, permission titles, and error messages.) The mapped `body` is a fixed,
safe string, not raw content. This is a hard requirement, not a nicety.

**Throw on an unknown payload.** An unmappable shape must raise a typed error (Codex throws
`CodexMappingError`) — never a malformed event. The hook pipeline catches it and `skip`s the fire so
the harness is never disturbed.

### Step 2 — build a draft and call the shared normalizer

Assemble a plain draft and pass it to `normalizeEvent` from `@birdybeep/agent-core`. The shared
normalizer hashes the `cwd`, redacts secrets, truncates strings, enforces the size cap, and
validates against the canonical schema (or throws `NormalizeError`):

```ts
function buildAndNormalize(input: unknown, opts: NormalizeOptions): BirdyBeepAgentEvent {
  const payload = asRecord(input);
  const mapped = mapCodexPayload(payload); // throws on unknown
  const machine = getMachineIdentity();
  const draft = {
    event_type: mapped.eventType,
    status: mapped.status,
    harness: "codex",
    source_session_id: deriveSessionId(payload),
    machine: { label: machine.label, os: machine.os },
    workspace: { cwd: str(payload["cwd"]) ?? "unknown" },
    title: mapped.title,
    body: mapped.body,
    metadata: mapped.metadata,
  };
  return normalizeEvent(draft, opts); // hashes cwd, redacts, truncates, size-caps, validates
}
```

### What the shared normalizer guarantees

The canonical payload ([`event.ts`](../packages/agent-core/src/event.ts)) carries: `event_id`,
`event_type`, `occurred_at`, `harness`, `harness_version?`, `source_session_id`,
`machine{label,os}`, `workspace{cwd, repo_name?, branch?}`, `status`, `title`, `body`, `metadata?`.
Before any of it leaves the machine, the normalizer:

- **Hashes absolute paths** to a stable, irreversible token (`h_<16 hex>`). `workspace.cwd` is
  **always** hashed; any absolute path found inside a string is scrubbed too. The same input always
  hashes to the same token, so grouping by workspace still works server-side without exposing the
  path.
- **Redacts secret-shaped strings** to `[redacted]` — AWS access keys, GitHub/OpenAI/Slack tokens,
  JWTs, and `key=value` secrets (`bearer`/`token`/`secret`/`password`/`api_key`).
- **Truncates** strings — `title` to 200 chars, `body` to 2000, metadata values to 500 — and bounds
  metadata depth/breadth.
- **Enforces a 16 KB total cap**, deterministically shrinking an over-cap event (drop metadata →
  shorten body → shorten title) before giving up.
- **Validates** the result against the canonical zod schema, throwing `NormalizeError` if it can't
  be made valid and under-cap.

Because the normalizer owns all of this, an adapter's only privacy duty is **never to put raw
content into the draft in the first place** — map to safe discriminators and let the shared layer be
the backstop. The backend, by design, does not persist notification `title`/`body` — only metadata,
hashes, delivery, and session status — but the local redaction rules are what keep secrets and paths
on the machine regardless.

---

## Non-destructive install patterns

Every install path obeys the same shape. Using Codex
([`install.ts`](../packages/codex/src/install.ts)) as the model:

**1. Resolve the config path `HOME`-relative.** Honor any harness override env var (Codex uses
`$CODEX_HOME`) and fall back to the conventional dir. Never hard-code an absolute home path — the
E2E harness runs installs against an isolated temporary `HOME`, and real users have non-standard
homes too.

**2. Read + parse what's already there** (empty if absent). Keep a record of every user key.

**3. Merge in only BirdyBeep-managed entries.** Append, never overwrite a user's own hook. Codex
identifies its own entries by the managed command string, so a re-merge is a no-op:

```ts
export function mergeCodexConfig(config: Record<string, unknown>) {
  let changed = false;
  const merged = { ...config };
  if (!notifyIsManaged(merged["notify"])) {
    merged["notify"] = [...BIRDYBEEP_NOTIFY]; // ["birdybeep", "hook", "codex"]
    changed = true;
  }
  const nextHooks = { ...asRecord(merged["hooks"]) };
  for (const event of BIRDYBEEP_HOOK_EVENTS) {
    const current = Array.isArray(nextHooks[event]) ? [...nextHooks[event]] : [];
    if (!current.some(isBirdyBeepHookEntry)) {
      current.push(birdyBeepHookEntry()); // append — never clobber a user hook
      changed = true;
    }
    nextHooks[event] = current;
  }
  merged["hooks"] = nextHooks;
  return { merged, changed };
}
```

**4. If nothing changed, return early** with `changed: false` — that is the idempotency guarantee
(`birdybeep agent install` twice is identical to once).

**5. On `dryRun`, report the would-change files without writing.**

**6. Back up once, then write.** Copy the existing file to a backup (Codex uses a
`.birdybeep-backup` suffix) only if a backup doesn't already exist, then write the merged config.

**7. Return `changedFiles`, `backupFiles`, `requiredActions`, and the resulting `status`.**

The CLI prints `requiredActions` to the user — this is how a one-time trust or restart instruction
reaches them.

### The token is never embedded

The installed config invokes a bare command — `birdybeep hook codex` — with **no token in it**. The
hook reads the machine token from secure storage at event time. Tokens live in the OS keychain when
available, else a strict-permission (`0600`) file in the user config dir
([`token-store.ts`](../packages/agent-core/src/token-store.ts)); they are **never** written into
harness config or any repo file, and the server only ever stores token _hashes_. The snapshot tests
assert the generated config contains no `bbm_`/`Bearer`/`token=` material.

### Generated config example

Here is the exact Codex `config.toml` block BirdyBeep generates from scratch
([`examples/codex/config.toml`](../examples/codex/config.toml) — one event shown; the others are
identical bar the event name):

```toml
notify = [ "birdybeep", "hook", "codex" ]

[[hooks.SessionStart]]
matcher = ""

[[hooks.SessionStart.hooks]]
type = "command"
command = "birdybeep hook codex"
timeout = 10
```

---

## The `needs_trust` / `needs_restart` pattern

Some harnesses don't activate the moment you write their config. Two cases ship today:

- **Codex** requires a one-time hook **trust**: it skips untrusted `[[hooks.X]]` entries until the
  user reviews and trusts them via `/hooks`. Writing config is therefore **not** "installed".
- **OpenCode** loads plugins only at startup, so the user must **restart** OpenCode after install.

For these, `install()` returns `needs_trust` / `needs_restart` and surfaces the instruction in
`requiredActions`. `status()` keeps returning that value **until the first real event proves the
gate was cleared** — an untrusted hook never fires, and an unloaded plugin never fires, so the
arrival of a real event is the only honest proof.

Codex implements this with a small **trust marker** file in the BirdyBeep data dir (strict perms,
never repo-local), carrying a timestamp only — never notification content
([`trust.ts`](../packages/codex/src/trust.ts)):

```ts
export async function runCodexHook(rawInput, options): Promise<HookResult> {
  const result = await runAgentHook(codexAdapter, rawInput, options);
  if (result.outcome !== "skipped") recordCodexEventSeen(options); // first real event = trust granted
  return result;
}
```

`status()` then reads the marker: config fully written **and** an event seen → `installed`;
config written but no event yet → `needs_trust`. `uninstall()` clears the marker. If your harness
has any gating step (trust prompt, restart, an enable toggle), follow this shape: write config, hold
the gated status, and flip to `installed` only on observed first-event delivery.

---

## The hook runtime: `runAgentHook` + dedup + sender

When the harness fires, the installed command runs `birdybeep hook <harness>`, which feeds the raw
payload (stdin, or the trailing argv argument for Codex `notify`) through the shared pipeline in
[`packages/agent-core/src/hook.ts`](../packages/agent-core/src/hook.ts). The pipeline **never throws
into or blocks the harness**:

```ts
export async function runAgentHook(adapter, rawInput, options): Promise<HookResult> {
  let event;
  try {
    event = await adapter.normalizeEvent(rawInput);
  } catch {
    return { outcome: "skipped" }; // unmappable payload → ignore, don't disturb the harness
  }
  const ledger = options.ledger ?? new RecentEventLedger();
  if (ledger.markAndCheck(eventIdentity(event))) {
    return { outcome: "deduped", eventType: event.event_type }; // same beep already sent
  }
  const send = await options.sender.send(event);
  return { outcome: send.outcome, eventType: event.event_type, send };
}
```

- **Dedup** ([`dedup.ts`](../packages/agent-core/src/dedup.ts)): a single user action can fire more
  than one hook. The ledger collapses a repeat of the same identity
  (`harness:session:event_type`) inside a short window (default 10s), so the user gets one beep, not
  two. It fails **open** — a ledger I/O error allows the send rather than dropping a notification.
- **Sender** ([`sender.ts`](../packages/agent-core/src/sender.ts)): `POST`s the event to
  `/v1/agent-events` with a short hard timeout (default 3s), reading the token from secure storage
  at send time. On timeout/network/transient failure it **queues** the event and returns fast; it
  also opportunistically drains the backlog on each send. The
  [local queue](../packages/agent-core/src/queue.ts) is best-effort, 24h retention, strict perms,
  and **never blocks the harness**.

The outcome is one of `delivered` / `queued` / `dropped` / `deduped` / `skipped`.

Most adapters can use `runAgentHook` directly. Wrap it only when you need an extra side effect on
first delivery — Codex's `runCodexHook` wraps it solely to write the trust marker.

---

## Wiring a new adapter into the CLI

1. **Create a package** under `packages/<harness>` (copy the shape of `packages/codex`): an
   `adapter.ts` object literal plus per-method files, `paths.ts`, an `index.ts` barrel, and a
   `package.json` depending on `@birdybeep/agent-core`.
2. **Add the harness id** to `HARNESS_IDS` in
   [`primitives.ts`](../packages/agent-core/src/primitives.ts) and note the lockstep change on your
   ticket (the private `@birdybeep/shared` must add the same id; the parity test enforces it).
3. **Register the adapter** with the CLI so `birdybeep agent install|uninstall <harness>`,
   `status`, `doctor`, and `hook <harness>` route to it. The CLI consumes the `AgentAdapter`
   contract uniformly — there is nothing harness-specific to add beyond listing your adapter.
4. **Add a generated example** under `examples/<harness>/` showing exactly what BirdyBeep adds to
   the config.

---

## Testing expectations

An adapter is not done until it is **proven end-to-end against a real harness payload**. "The code
looks right" is not a completion claim in this repo. Three layers, all required:

### 1. Snapshot tests (config generation + non-destructive patching)

Lock the exact config your installer generates, and prove non-destructive patching against realistic
pre-existing configs (unrelated keys, different key order, a user's own hook, a single-valued field
your install overwrites). See [`packages/codex/src/snapshot.test.ts`](../packages/codex/src/snapshot.test.ts).
It asserts:

- from-scratch install matches a committed snapshot;
- patching preserves unrelated user keys and a same-event user hook;
- **double-install is idempotent** (second output identical to first);
- **install → uninstall returns to the original fixture byte-for-byte**;
- the generated config contains **no secrets** (`Bearer`/`bbm_`/`token=`).

Snapshots are deterministic (no machine paths, timestamps, or tokens in generated config), so they
are stable across machines. Regenerate them **intentionally**, never blindly.

### 2. Real-hook E2E through the stub sink

The mandatory gate. Install the **real** adapter into a **hermetic temporary `HOME`**, fire the
**actual** payloads the harness emits, and assert the normalized event is produced and **delivered**
to a stub event sink. See [`packages/codex/src/e2e.test.ts`](../packages/codex/src/e2e.test.ts),
which uses `createSandbox`, `StubEventSink`, and the privacy assertions from
`@birdybeep/test-harness`. It proves:

- correct §10.1 mapping for **every** harness surface;
- the `needs_trust` → `installed` transition (the Codex-specific gate): `needs_trust` before any
  event, `installed` after the first delivered one;
- the token resolves from the strict-perm **file fallback** (no keychain), rides as a `Bearer`
  header, and **never** appears in the installed config or the event body;
- absolute paths are hashed, nothing exceeds the cap, and **no user/assistant content** (e.g.
  `tool_input`, last-assistant message) is persisted;
- **dedup** collapses a repeated event to exactly one beep;
- **offline**: an unreachable backend queues the event and returns fast, draining on a later send;
- the hook **returns fast** (never blocks the harness).

A unit test of the mapper is necessary but **not sufficient** — the E2E is the bar. (The stub-sink
E2E is the in-repo gate; the cross-repo live-delivery run against the product's `wrangler dev`
backend is the deferred end-to-end check.)

### 3. `doctor()` actually diagnoses

Induce each failure mode your `doctor()` claims to catch (missing token, untrusted/needs-restart,
malformed config, unwritable config) and assert it reports the failure with the right `remedy`. See
[`packages/codex/src/status.test.ts`](../packages/codex/src/status.test.ts).

### Running the suite

```bash
pnpm install
pnpm turbo lint typecheck test   # includes adapter snapshot tests
pnpm test:e2e                    # real install into a temp HOME + fire harness events
```

The **pre-push hook** re-runs lint + typecheck + unit + snapshot + adapter smoke and **blocks the
push** on failure; **CI** re-runs the full matrix on macOS, Linux, and Windows. Never bypass them,
never weaken a test to pass, and never merge on red.

### Cross-platform notes

The CLI must work on macOS, Linux, and Windows. Don't assume POSIX paths, `$HOME`, or a keychain:
resolve paths with `node:path`, read `HOME` through the shared helpers, and rely on the `agent-core`
token store (OS keychain with a strict-perm file fallback) — and test the fallback path, since CI
exercises it.

---

## Checklist for a new adapter

- [ ] `id` added to `HARNESS_IDS` (lockstep change flagged on the ticket).
- [ ] All seven members implemented: `id`, `displayName`, `detect`, `install`, `uninstall`,
      `status`, `doctor`, `normalizeEvent`.
- [ ] `detect()` is side-effect-free, `HOME`-relative, never throws.
- [ ] `install()` is idempotent, backs up once, adds only managed entries, writes no token, honors
      `dryRun`.
- [ ] `uninstall()` restores byte-for-byte when untouched; preserves user edits otherwise.
- [ ] `status()` / `doctor()` are read-only; a gated harness holds `needs_trust`/`needs_restart`
      until the first real event.
- [ ] `normalizeEvent()` maps to a `BirdyBeepEventType`, carries only safe discriminators, drops raw
      content, and defers all redaction/hashing/truncation to the shared normalizer.
- [ ] Snapshot tests, real-hook E2E through the stub sink, and `doctor()` failure-mode tests all
      green.
- [ ] A generated `examples/<harness>/` config committed.
