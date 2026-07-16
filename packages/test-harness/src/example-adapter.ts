/**
 * Reference adapter — the "at least one wired example" that proves the rig works
 * end-to-end (this ticket's acceptance). It is a DELIBERATE stand-in for the real
 * Claude Code adapter (a-claude / CC-E2E), faithful enough to exercise every
 * harness capability:
 *   - install: non-destructively patch `~/.claude/settings.json`, backing up any
 *     pre-existing file, idempotently (a marker makes a second install a no-op).
 *   - uninstall: restore the backup byte-for-byte (or remove what we created).
 *   - normalize: map a real Claude Code hook payload → the §10.2 event shape,
 *     HASHING absolute paths and TRUNCATING the body before it can leave.
 *   - fire: read the machine token from the file-fallback store (no keychain on
 *     CI Linux/Windows) and POST the normalized event to the sink with a Bearer.
 *
 * When agent-core + the real adapter land, they replace the normalize/install
 * logic here; the sandbox/sink/contract assertions stay exactly as they are.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { ClaudeCodeHookCommon } from "./fixtures";
import type { Sandbox } from "./sandbox";

/** Relative (to HOME) path of the Claude Code settings file the adapter patches. */
export const SETTINGS_REL = ".claude/settings.json";
/** Relative path of the backup the adapter writes before first modifying settings. */
export const BACKUP_REL = ".claude/settings.json.birdybeep-backup";
/** Relative path of the file-fallback machine token store (under XDG_CONFIG_HOME). */
export const TOKEN_REL = ".config/birdybeep/token";

/** Max body length the adapter sends — proves truncation/redaction (real value tuned in agent-core). */
export const BODY_TRUNCATE_AT = 280;

/** §10.2-shaped normalized event. Replaced by agent-core's `AgentEvent` type when it lands. */
export interface NormalizedEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  harness: string;
  harness_version?: string;
  source_session_id: string;
  machine: { label: string; os: string };
  workspace: { cwd: string; repo_name?: string; branch?: string };
  status: string;
  title: string;
  body: string;
}

/**
 * Hash an absolute path so it never leaves the machine raw (§8.6 / §15.2). Full
 * SHA-256 hex — the real redaction policy (truncation length, salting) is owned by
 * agent-core's normalizer (CORE-NORMALIZER); here we only need "raw path absent".
 */
function hashPath(path: string): string {
  return `h_${createHash("sha256").update(path).digest("hex")}`;
}

function truncate(text: string, max = BODY_TRUNCATE_AT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Seed the file-fallback token store inside the sandbox (strict perms). Returns its path. */
export function seedFileToken(sandbox: Sandbox, token: string): string {
  const tokenPath = sandbox.path(TOKEN_REL);
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return tokenPath;
}

function readFileToken(sandbox: Sandbox): string {
  const tokenPath = sandbox.path(TOKEN_REL);
  if (!existsSync(tokenPath)) {
    throw new Error(`no machine token in file store (${tokenPath}); run \`birdybeep pair\` first`);
  }
  return readFileSync(tokenPath, "utf8").trim();
}

export interface InstallResult {
  settingsPath: string;
  /** Set when a pre-existing settings file was backed up. */
  backupPath?: string;
  /** False when the install was a no-op (already managed). */
  changed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export const referenceAdapter = {
  /** Non-destructive, idempotent install into `~/.claude/settings.json`. */
  install(sandbox: Sandbox): InstallResult {
    const settingsPath = sandbox.path(SETTINGS_REL);
    const backupPath = sandbox.path(BACKUP_REL);
    const existedBefore = existsSync(settingsPath);
    const raw = existedBefore ? readFileSync(settingsPath, "utf8") : undefined;

    let parsed: Record<string, unknown> = {};
    if (raw !== undefined && raw.trim().length > 0) {
      parsed = asRecord(JSON.parse(raw));
    }

    // Idempotency: our marker already present → no-op (no re-backup, no rewrite).
    if (asRecord(parsed["_birdybeep"])["managed"] === true) {
      return existsSync(backupPath)
        ? { settingsPath, backupPath, changed: false }
        : { settingsPath, changed: false };
    }

    mkdirSync(dirname(settingsPath), { recursive: true });
    // Back up any pre-existing user config byte-for-byte before we touch it.
    if (existedBefore) copyFileSync(settingsPath, backupPath);

    const userHooks = asRecord(parsed["hooks"]);
    const managed = {
      ...parsed,
      _birdybeep: { managed: true },
      hooks: {
        ...userHooks,
        Notification: [
          { matcher: "", hooks: [{ type: "command", command: "birdybeep hook claude" }] },
        ],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "birdybeep hook claude" }] }],
      },
    };
    writeFileSync(settingsPath, `${JSON.stringify(managed, null, 2)}\n`);

    return existedBefore
      ? { settingsPath, backupPath, changed: true }
      : { settingsPath, changed: true };
  },

  /** Reverse install: restore the backup byte-for-byte, or remove what we created. */
  uninstall(sandbox: Sandbox): void {
    const settingsPath = sandbox.path(SETTINGS_REL);
    const backupPath = sandbox.path(BACKUP_REL);
    if (existsSync(backupPath)) {
      copyFileSync(backupPath, settingsPath);
      rmSync(backupPath, { force: true });
    } else if (existsSync(settingsPath)) {
      rmSync(settingsPath, { force: true });
    }
  },

  /** Map a real Claude Code hook payload → the normalized §10.2 event (paths hashed, body truncated). */
  normalize(payload: ClaudeCodeHookCommon): NormalizedEvent {
    const { eventType, status, rawText } = mapClaudeCode(payload);
    return {
      event_id: `evt_local_${randomUUID()}`,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      harness: "claude_code",
      harness_version: "test-fixture",
      source_session_id: payload.session_id,
      machine: { label: "ci-sandbox", os: process.platform },
      workspace: { cwd: hashPath(payload.cwd) },
      status,
      title: truncate(rawText, 80),
      body: truncate(rawText),
    };
  },

  /**
   * Normalize + send: read the file-store token and POST the event to the ingestion
   * `endpoint`. Takes a plain URL (not the test sink) exactly as a real adapter
   * would — it knows only a configured endpoint, never the harness internals.
   */
  async fire(
    payload: ClaudeCodeHookCommon,
    opts: { endpoint: string; sandbox: Sandbox },
  ): Promise<NormalizedEvent> {
    const event = this.normalize(payload);
    const token = readFileToken(opts.sandbox);
    const res = await fetch(opts.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(event),
    });
    await res.arrayBuffer(); // drain
    if (!res.ok) throw new Error(`sink rejected event: HTTP ${res.status}`);
    return event;
  },
};

/** Reference §9.5 mapping (the real, exhaustive table lives in the a-claude adapter ticket). */
function mapClaudeCode(payload: ClaudeCodeHookCommon): {
  eventType: string;
  status: string;
  rawText: string;
} {
  switch (payload.hook_event_name) {
    case "Notification": {
      const text = typeof payload["message"] === "string" ? payload["message"] : "Notification";
      const isApproval = payload["notification_type"] === "permission_prompt";
      return {
        eventType: isApproval ? "approval_required" : "needs_input",
        status: isApproval ? "waiting_for_approval" : "waiting_for_input",
        rawText: text,
      };
    }
    case "Stop":
      return { eventType: "agent_completed", status: "completed", rawText: "Turn finished" };
    case "SessionStart":
      return { eventType: "session_started", status: "starting", rawText: "Session started" };
    default:
      return { eventType: "custom", status: "unknown", rawText: payload.hook_event_name };
  }
}
