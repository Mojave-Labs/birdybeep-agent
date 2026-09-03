# Security and privacy

BirdyBeep sends a bounded event record. It excludes prompts, assistant replies, tool input and output, file contents, and readable absolute paths. This page lists the accepted fields and explains how events and tokens are stored.

## Event payload

Every adapter produces the payload defined in [`packages/agent-core/src/event.ts`](../packages/agent-core/src/event.ts). The sender posts this payload to `POST /v1/agent-events`:

```jsonc
{
  "event_id": "evt_local_…",
  "event_type": "agent_completed",
  "occurred_at": "2026-06-14T…Z",
  "harness": "claude_code",
  "harness_version": "…",
  "source_session_id": "…",
  "machine": {
    "label": "…",
    "os": "…",
  },
  "workspace": {
    "cwd": "h_1a2b3c4d5e6f7890",
    "repo_name": "birdybeep-agent",
    "branch": "main",
  },
  "status": "completed",
  "title": "Claude Code finished",
  "body": "Turn complete",
  "metadata": { "tool": "Bash", "session_name": "billing refactor" },
}
```

Only the fields shown above are accepted by the event schema. `harness_version`, `repo_name`, `branch`, and `metadata` are optional.

Per-tool events (`tool_started` and `tool_finished`) remain on the machine. They contribute to local status and diagnostic counts but are not sent to the backend. The filter is defined in [`notify-matrix.ts`](../packages/agent-core/src/notify-matrix.ts).

### Adapter-generated notification text

Adapters generate notification titles and bodies from lifecycle state. They do not use prompts or assistant replies as notification text.

- Codex excludes `input-messages`, `last-assistant-message`, and `tool_input`.
- OpenCode excludes tool arguments, permission titles, and error messages.
- Claude Code may include its notification `message` and a user-assigned session name after normalization.
- Cursor excludes `prompt`, `user_email`, `transcript_path`, tool input and output, and shell-command text.
- GitHub Copilot CLI excludes prompts, tool arguments and results, transcript paths, subagent responses, and error messages and stacks.

Safe lifecycle identifiers such as tool name, model, source, event name, status, and turn id may appear in metadata when the harness supplies them.

### Claude Code session names

A Claude Code session name set at session start may appear in the notification title and `metadata.session_name`. A name changed during the session takes effect with the next session because Claude Code supplies it through `SessionStart`.

Session names pass through path hashing, secret redaction, and truncation. They are limited to 120 characters. Sessions without a user-assigned name send no session-name field.

## Local normalization

[`normalize.ts`](../packages/agent-core/src/normalize.ts) processes event strings before the sender is called:

1. Replace absolute paths with hashes.
2. Replace recognized credential patterns with `[redacted]`.
3. Truncate bounded fields.
4. Reduce the event if necessary to remain within the 16 KB serialized limit.

### Path hashing

Absolute POSIX and Windows paths are replaced with `h_<16 hex>`, using the first 16 hexadecimal characters of a SHA-256 hash. `workspace.cwd` is always hashed. Absolute paths embedded in `source_session_id` are replaced before the id is used.

The same path produces the same hash. The original path is not sent.

### Secret redaction

The current patterns cover:

- AWS access key ids beginning with `AKIA`;
- GitHub tokens beginning with `ghp_`, `gho_`, `ghu_`, `ghs_`, or `ghr_`;
- OpenAI-style keys beginning with `sk-`;
- Slack tokens beginning with `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, or `xoxs-`;
- JWT-shaped values;
- `bearer`, `token`, `secret`, `password`, `passwd`, `api_key`, or `api-key` assignments.

### Field limits

| Field          | Maximum characters |
| -------------- | ------------------ |
| `title`        | 200                |
| `body`         | 2,000              |
| metadata value | 500                |
| label or key   | 120                |

Metadata accepts at most 64 keys per object and four levels of nesting. Functions and symbols are dropped.

If the serialized event exceeds 16 KB, normalization removes metadata, then reduces the body to 256 characters and the title to 120 characters. It rejects an event that still exceeds the limit.

## Tokens

Token handling is implemented in [`token-store.ts`](../packages/agent-core/src/token-store.ts).

| Concern               | Behavior                                                               |
| --------------------- | ---------------------------------------------------------------------- |
| Local storage         | OS keychain or a `0600` fallback file inside a `0700` directory        |
| Harness configuration | Contains no machine token                                              |
| Pairing link          | Contains a short-lived approval secret, not the machine token          |
| Server storage        | Stores the token hash                                                  |
| Account confirmation  | Runs before the CLI stores a newly minted token                        |
| Removal               | `logout` deletes local copies; `unpair` also revokes the server record |

`--expect-email <addr>` requires an exact approving-account match for unattended pairing. `--yes` accepts whichever account approved the request. See [Pairing](./pairing.md).

## Hook execution, backend storage, and retries

When a harness event occurs, the local hook reads the token, normalizes the event, hashes paths, redacts matching secrets, truncates bounded fields, and sends with a short timeout. Retryable failures are queued locally. No daemon runs between events.

The backend stores event metadata, hashes, delivery status, and session status. Notification title and body are not persisted by default. The push provider receives the title and body to deliver the notification.

The local queue is implemented in [`queue.ts`](../packages/agent-core/src/queue.ts). It retains events for up to 24 hours, stores at most 500 entries, uses restricted file permissions, and drops the oldest entries first. It drains during later hook execution and when `status` or `doctor` runs.

```bash
birdybeep queue clear
```

This command deletes all queued events.

When the machine has no token, events are not queued. The CLI records only the count, first and last timestamps, and harness ids in `unpaired-events.json`. Pairing deletes that record and discards any queue left from before pairing.

When token storage cannot be read, events are queued because the pairing state is unknown. `status` and `doctor` report `Paired: unknown`.

## Inspect the implementation

- [`event.ts`](../packages/agent-core/src/event.ts) defines accepted fields.
- [`normalize.ts`](../packages/agent-core/src/normalize.ts) defines redaction, hashing, and limits.
- Each adapter's `normalize.ts` shows which harness fields are excluded.
- `birdybeep test --json` reports whether a test event was delivered, queued, or rejected.
- `birdybeep doctor` reports pairing, adapter, queue, device, quota, and backend status.
