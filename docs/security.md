# Security & privacy

BirdyBeep runs inside your coding harness, watches lifecycle events, and ships small notifications to
your phone. This package is MIT-licensed and public on purpose: the code that touches your machine is
meant to be read. This page documents, precisely and against the code, what leaves your machine, what
is hashed/redacted/truncated before it does, and where your token lives.

If you find a gap between this page and the code, the code wins — please open an issue. Every claim
below cites the file that enforces it.

## TL;DR

- We send a **small, fixed-shape event** — event type, status, a short generated title/body, machine
  label, hashed working directory, and a little metadata. We do **not** send your prompts, the
  assistant's replies, tool inputs/outputs, file contents, or raw file paths.
- Before anything is sent the hook **hashes absolute paths**, **redacts secret-shaped strings**, and
  **truncates** every field, under a hard **16 KB** total cap.
- Your machine token lives in the **OS keychain** (or a strict-permission `0600` file fallback) — never
  in a repo file or harness config. The server only ever stores a **hash** of it.
- The backend does **not** persist the notification title/body by default — only metadata, hashes,
  delivery status, and session status.

## What leaves your machine

Every adapter normalizes its harness's events into one canonical payload before sending. The shape is
defined in [`packages/agent-core/src/event.ts`](../packages/agent-core/src/event.ts) and is the only
thing the sender transmits (to `POST /v1/agent-events`). These are the exact fields:

```jsonc
{
  "event_id": "evt_local_…", // generated locally if the harness gives none
  "event_type": "agent_completed", // enum (session_started, approval_required, tool_finished, …)
  "occurred_at": "2026-06-14T…Z", // ISO timestamp
  "harness": "claude_code", // claude_code | codex | opencode
  "harness_version": "…", // optional
  "source_session_id": "…", // harness session id (paths scrubbed); else a hash
  "machine": {
    "label": "…", // your machine label (truncated)
    "os": "…", // free-form OS string the adapter reports
  },
  "workspace": {
    "cwd": "h_1a2b3c4d5e6f7890", // ALWAYS hashed — the raw path never leaves
    "repo_name": "birdybeep-agent", // optional, kept if available (cleaned)
    "branch": "main", // optional, kept if available (cleaned)
  },
  "status": "completed", // session status enum
  "title": "Claude Code finished", // short, generated label (truncated to 200 chars)
  "body": "Turn complete", // short, generated body (truncated to 2000 chars)
  "metadata": { "tool": "Bash" }, // optional, safe discriminators only (see below)
}
```

That is the complete list. There is no field for prompt text, assistant output, tool arguments, file
contents, diffs, or absolute paths.

### The titles and bodies are generated, not captured

The `title` and `body` you see above are written by the adapter, not lifted from your session. For
example, every "finished" event sends the literal string `Turn complete`; an approval event sends
`Approval requested` or `Approve <tool>?`. The adapters
([claude-code](../packages/claude-code/src/normalize.ts),
[codex](../packages/codex/src/normalize.ts), [opencode](../packages/opencode/src/normalize.ts))
deliberately do **not** copy raw user/assistant content into the event:

- **Codex** drops `input-messages`, `last-assistant-message`, and `tool_input`. Only safe identifiers
  (tool name, turn id, client, model, source) flow as metadata.
- **OpenCode** drops tool args, permission titles, and error messages. Only safe discriminators (tool
  name, permission type, error class name, status) flow.
- **Claude Code** carries only the harness-provided notification `message` (already redacted and
  truncated by the shared normalizer) plus safe discriminators (notification type, tool name, error
  type, source, model).

Where a harness _does_ hand the adapter a free-text string (e.g. Claude Code's notification message),
it still passes through the full clean pipeline below before it can leave the machine.

## Hashing, redaction, truncation, and the size cap

All of this runs in [`packages/agent-core/src/normalize.ts`](../packages/agent-core/src/normalize.ts)
on the local machine, before the sender is called. Every string field goes through the pipeline
**scrub paths → redact secrets → truncate**, and the whole event is then forced under the 16 KB cap.

### Absolute paths are hashed

Any absolute path inside a string is replaced with a stable, irreversible token `h_<16 hex>` — the
first 16 hex chars of its SHA-256. POSIX (`/a/b/…`) and Windows (`C:\a\…`) paths are both matched.

- `workspace.cwd` is treated as an absolute path and is **always hashed** — the raw cwd never leaves
  the machine.
- `source_session_id` has any embedded absolute path scrubbed before it is used as a key.

The hash is stable (same path → same token across runs), so the backend can correlate events from the
same workspace without ever seeing the path. It is not reversible.

### Secret-shaped strings are redacted

Before truncation, substrings that look like credentials are replaced wholesale with `[redacted]`. The
patterns (best-effort; truncation is the backstop) cover:

- AWS access key ids (`AKIA…`)
- GitHub tokens (`ghp_…`, `gho_…`, `ghu_…`, `ghs_…`, `ghr_…`)
- OpenAI-style keys (`sk-…`)
- Slack tokens (`xoxb-…`, `xoxa-…`, `xoxp-…`, `xoxr-…`, `xoxs-…`)
- JWTs (`eyJ….….…`)
- `key=value` secrets — `bearer`, `token`, `secret`, `password`, `passwd`, `api_key` / `api-key`
  followed by `:` or `=` and a value

### Strings are truncated

Per-field caps (from `normalize.ts`):

| Field          | Max chars |
| -------------- | --------- |
| `title`        | 200       |
| `body`         | 2000      |
| metadata value | 500       |
| `label` / keys | 120       |

Metadata is also bounded structurally: at most 64 keys per object, max depth 4, and non-data values
(functions, symbols) are dropped.

### Hard 16 KB cap

The serialized event must fit under **16 KB** (`MAX_AGENT_EVENT_BYTES`, mirrored from the product
repo). If it doesn't, the normalizer deterministically shrinks it — drop `metadata`, then harden
`body` to 256 chars, then harden `title` to 120 chars — and throws rather than ever sending an
oversized or partially-valid event.

## Tokens

Token storage lives in
[`packages/agent-core/src/token-store.ts`](../packages/agent-core/src/token-store.ts).

- **Where it lives.** The machine token is stored in the **OS keychain** when one is available (on
  macOS, the built-in `security` keychain). On machines without a usable keychain (e.g. headless
  Linux, Windows today) it falls back to a **strict-permission file**: a `0600` file inside a `0700`
  directory under your user data dir (never repo-local). A too-permissive token file is repaired to
  `0600` on read.
- **Never in your repo or harness config.** Installers write **no token** into harness config or any
  repo file. `birdybeep agent install` only adds BirdyBeep-managed config entries; the token is
  resolved at send time from the secure store.
- **The server stores only a hash.** Machine tokens are shown once at pairing and the backend stores
  only the token **hash**. The pairing QR/code carries only short-lived pairing info, never a durable
  token.
- **Revoke & rotate.** Tokens can be revoked and rotated from the mobile app. Locally, `birdybeep
logout` clears the token from **both** the keychain and the file fallback (idempotent).

## What the backend stores

Per [SPEC §11](./SPEC.md):

- The backend does **not** persist notification `title`/`body` content **by default**. It stores
  metadata, hashes, delivery status, and session status.
- The push provider receives the title/body only because it is required to render and deliver the
  notification to your device.
- The server stores only token **hashes**, never the raw token.

## Local machine storage (the queue)

If a send fails (offline, backend down), the event is written to a best-effort local retry queue
([`packages/agent-core/src/queue.ts`](../packages/agent-core/src/queue.ts)): **≤ 24h** retention,
strict file permissions, drained opportunistically on the next `hook` / `status` / `doctor`. It never
blocks or slows the harness. It is a retry buffer, not a durable audit log. Clear it any time with:

```bash
birdybeep queue clear
```

## How the hook path runs

The local pattern is: harness hook → `birdybeep hook <harness>` → read token → normalize → redact /
truncate / hash → send with a short timeout → queue on failure → return fast. There is **no background
daemon**. The `birdybeep hook <harness>` command is internal — it is invoked by the installed harness
config, reads the payload (stdin, or a trailing arg for Codex `notify`), runs everything above, and
always returns fast and exits 0 so it can never hang your session.

## Verify it yourself

This is the point of a public, auditable package — don't take our word for it:

- Read [`normalize.ts`](../packages/agent-core/src/normalize.ts) for the exact regexes, caps, and the
  16 KB shrink logic.
- Read [`event.ts`](../packages/agent-core/src/event.ts) for the only fields that can ever be sent.
- Read each adapter's `normalize.ts` to see precisely which harness fields are dropped.
- Run `birdybeep test --json` to send a single test event through the real sender and watch exactly
  what is delivered or queued, and `birdybeep doctor` to inspect token storage, adapter status, queue
  depth, and backend reachability.

## Provisional / changing surfaces

- The `login` device-flow pairing endpoints (`POST /v1/cli/pair`, `POST /v1/cli/pair/poll`) and the
  integration-status endpoint are **provisional** and not yet pinned in the product repo — the field
  names may change.
- The redaction patterns are best-effort. Truncation and the structural metadata bounds are the
  backstop, but if you handle especially sensitive material, treat the redaction list as a helpful
  default rather than a guarantee and review what your adapter emits.
