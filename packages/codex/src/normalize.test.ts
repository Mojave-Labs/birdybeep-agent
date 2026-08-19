/**
 * CX-NORMALIZE proof: every Codex surface in the §9.6 table maps to the exact §10.1
 * event type, §10.4 status, and §10.5 notify-default (which follows from event_type);
 * privacy invariants hold (cwd hashed, no raw absolute paths, no user/assistant content
 * persisted); session identity is stable across events of one session; and unknown
 * payloads reject (CodexMappingError) rather than emit garbage.
 *
 * Fixtures use the REAL Codex payload shapes (verified against openai/codex source):
 * notify = argv JSON, kebab-case keys, keyed by `type`; hooks = stdin JSON, snake_case
 * keys, keyed by `hook_event_name`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cliVersionFromRollout,
  CodexMappingError,
  codexSurfaceFromPayload,
  normalizeCodexEvent,
} from "./normalize";

const OPTS = { now: () => "2026-06-14T00:00:00.000Z", generateId: () => "evt_test_1" } as const;
const CWD = "/Users/alice/project";

interface Case {
  name: string;
  payload: Record<string, unknown>;
  eventType: string;
  status: string;
  body: string;
  /** §10.5 notify-default (documentation; the server derives it from event_type). */
  notifyDefault: boolean;
}

const CASES: Case[] = [
  {
    name: "notify agent-turn-complete → agent_completed",
    payload: {
      type: "agent-turn-complete",
      "thread-id": "thread-abc-123",
      "turn-id": "turn-42",
      cwd: CWD,
      client: "codex-tui",
      "input-messages": ["Rename foo to bar"],
      "last-assistant-message": "Done.",
    },
    eventType: "agent_completed",
    status: "completed",
    body: "Turn complete",
    notifyDefault: true,
  },
  {
    name: "hook SessionStart (startup) → session_started",
    payload: {
      hook_event_name: "SessionStart",
      session_id: "sess-1",
      cwd: CWD,
      source: "startup",
      model: "gpt-5",
    },
    eventType: "session_started",
    status: "starting",
    body: "",
    notifyDefault: false,
  },
  {
    name: "hook SessionStart (resume) → session_resumed",
    payload: { hook_event_name: "SessionStart", session_id: "sess-1", cwd: CWD, source: "resume" },
    eventType: "session_resumed",
    status: "running",
    body: "",
    notifyDefault: false,
  },
  {
    name: "hook PermissionRequest → approval_required",
    payload: {
      hook_event_name: "PermissionRequest",
      session_id: "sess-1",
      cwd: CWD,
      tool_name: "Bash",
      tool_input: { command: "rm -rf /Users/alice/secret-dir/data" },
    },
    eventType: "approval_required",
    status: "waiting_for_approval",
    body: "Approve Bash?",
    notifyDefault: true,
  },
  {
    name: "hook PostToolUse → tool_finished",
    payload: {
      hook_event_name: "PostToolUse",
      session_id: "sess-1",
      cwd: CWD,
      tool_name: "Edit",
      tool_input: { file_path: "/Users/alice/project/src/secret.ts" },
      tool_response: { ok: true },
      tool_use_id: "tu-1",
    },
    eventType: "tool_finished",
    status: "running",
    body: "Edit finished",
    notifyDefault: false,
  },
  {
    name: "hook SubagentStart → subagent_started",
    payload: {
      hook_event_name: "SubagentStart",
      session_id: "sess-1",
      cwd: CWD,
      agent_type: "explorer",
      agent_id: "sub-1",
    },
    eventType: "subagent_started",
    status: "running",
    body: "Subtask started",
    notifyDefault: false,
  },
  {
    name: "hook SubagentStop → subagent_completed",
    payload: {
      hook_event_name: "SubagentStop",
      session_id: "sess-1",
      cwd: CWD,
      agent_type: "explorer",
      agent_id: "sub-1",
    },
    eventType: "subagent_completed",
    status: "running",
    body: "Subtask complete",
    notifyDefault: false,
  },
  {
    name: "hook Stop → agent_completed",
    payload: { hook_event_name: "Stop", session_id: "sess-1", cwd: CWD },
    eventType: "agent_completed",
    status: "completed",
    body: "Turn complete",
    notifyDefault: true,
  },
];

describe("§9.6 → §10.1 mapping table", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const evt = await normalizeCodexEvent(c.payload, OPTS);
      expect(evt.event_type).toBe(c.eventType);
      expect(evt.status).toBe(c.status);
      expect(evt.body).toBe(c.body);
      expect(evt.harness).toBe("codex");
      // cwd is always hashed (§10.3) — never the raw absolute path.
      expect(evt.workspace.cwd).toMatch(/^h_[0-9a-f]{16}$/);
      // Output uses only enum values from BirdyBeepEventType / AgentSessionStatus.
      expect(evt.event_id).toBe("evt_test_1");
      expect(evt.occurred_at).toBe("2026-06-14T00:00:00.000Z");
    });
  }
});

describe("session identity (§10.3)", () => {
  it("derives source_session_id from notify thread-id", async () => {
    const evt = await normalizeCodexEvent(
      { type: "agent-turn-complete", "thread-id": "thread-xyz", cwd: CWD },
      OPTS,
    );
    expect(evt.source_session_id).toBe("thread-xyz");
  });

  it("derives source_session_id from hook session_id and is stable across a session", async () => {
    const first = await normalizeCodexEvent(
      { hook_event_name: "PostToolUse", session_id: "sess-stable", cwd: CWD, tool_name: "Bash" },
      OPTS,
    );
    const second = await normalizeCodexEvent(
      { hook_event_name: "Stop", session_id: "sess-stable", cwd: CWD },
      OPTS,
    );
    expect(first.source_session_id).toBe("sess-stable");
    expect(second.source_session_id).toBe("sess-stable");
  });

  it("falls back to a deterministic best-effort id when none is provided", async () => {
    const payload = { hook_event_name: "Stop", cwd: CWD };
    const a = await normalizeCodexEvent(payload, OPTS);
    const b = await normalizeCodexEvent(payload, OPTS);
    expect(a.source_session_id).toMatch(/^cx_[0-9a-f]{16}$/);
    expect(a.source_session_id).toBe(b.source_session_id);
  });
});

describe("privacy invariants (§15.6)", () => {
  it("hashes the cwd and never lets a raw absolute path through", async () => {
    const evt = await normalizeCodexEvent(
      { hook_event_name: "PostToolUse", session_id: "s", cwd: CWD, tool_name: "Edit" },
      OPTS,
    );
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain(CWD);
    expect(serialized).not.toMatch(/\/Users\/alice/);
  });

  it("never persists user/assistant content from notify (input/last-assistant-message)", async () => {
    const secret = "Token sk-abcdefghijklmnop1234 lives at /Users/alice/.ssh/id_rsa";
    const evt = await normalizeCodexEvent(
      {
        type: "agent-turn-complete",
        "thread-id": "t",
        cwd: CWD,
        "input-messages": ["please leak /Users/alice/secret"],
        "last-assistant-message": secret,
      },
      OPTS,
    );
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain("sk-abcdefghijklmnop1234");
    expect(serialized).not.toContain("id_rsa");
    expect(serialized).not.toContain("please leak");
    expect(evt.body).toBe("Turn complete");
  });

  it("never persists tool_input content from a hook payload", async () => {
    const evt = await normalizeCodexEvent(
      {
        hook_event_name: "PermissionRequest",
        session_id: "s",
        cwd: CWD,
        tool_name: "Bash",
        tool_input: { command: "cat /Users/alice/secret-dir/credentials.json" },
      },
      OPTS,
    );
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain("credentials.json");
    expect(serialized).not.toContain("secret-dir");
    expect(evt.body).toBe("Approve Bash?");
  });
});

describe("unknown / garbled inputs reject (caught + skipped by runAgentHook)", () => {
  it("rejects an unknown hook_event_name", async () => {
    await expect(
      normalizeCodexEvent({ hook_event_name: "PreCompact", session_id: "s", cwd: CWD }),
    ).rejects.toBeInstanceOf(CodexMappingError);
  });

  it("rejects an unknown notify type", async () => {
    await expect(
      normalizeCodexEvent({ type: "some-future-type", cwd: CWD }),
    ).rejects.toBeInstanceOf(CodexMappingError);
  });

  it("rejects a payload with neither hook_event_name nor type", async () => {
    await expect(normalizeCodexEvent({ cwd: CWD })).rejects.toBeInstanceOf(CodexMappingError);
  });
});

/**
 * birdybeep-agent-gcgp.7 — Codex's terminal CLI and the build bundled inside ChatGPT.app
 * share ONE `~/.codex/config.toml`: same hooks, same trust state, same everything. The only
 * thing that separates them on the wire is the `cli_version` each writes into the
 * `session_meta` line that opens its own rollout, which every hook payload points at via
 * `transcript_path` (required on all ten hook events by Codex's own payload schemas).
 *
 * The two versions below are real: one sandbox CODEX_HOME, two binaries, captured 2026-08-16 —
 * `codex-cli 0.135.0` (npm) and `codex-cli 0.148.0-alpha.9` (/Applications/ChatGPT.app).
 */
describe("harness_version from the rollout session_meta (gcgp.7)", () => {
  const rollouts: string[] = [];
  /** A real-shaped rollout: JSONL whose first record is `session_meta`. */
  function rollout(meta: Record<string, unknown>, extra = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "bb-cx-rollout-"));
    rollouts.push(dir);
    const file = join(dir, "rollout-2026-08-16T21-15-27-01a00d80.jsonl");
    const first = JSON.stringify({
      timestamp: "2026-08-17T02:15:27.218Z",
      type: "session_meta",
      payload: meta,
    });
    writeFileSync(file, `${first}\n${extra}`);
    return file;
  }
  afterEach(() => {
    for (const dir of rollouts.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const hook = (transcript: string) => ({
    hook_event_name: "Stop",
    session_id: "sess-hv",
    cwd: CWD,
    transcript_path: transcript,
    turn_id: "turn-1",
    model: "gpt-5.5",
  });

  it("reads the npm terminal CLI's version", async () => {
    const file = rollout({ originator: "codex_exec", cli_version: "0.135.0", source: "exec" });
    const ev = await normalizeCodexEvent(hook(file), OPTS);
    expect(ev.harness_version).toBe("0.135.0");
  });

  it("reads the ChatGPT.app-bundled build's version from the same config", async () => {
    const file = rollout({ originator: "codex_exec", cli_version: "0.148.0-alpha.9" });
    const ev = await normalizeCodexEvent(hook(file), OPTS);
    expect(ev.harness_version).toBe("0.148.0-alpha.9");
  });

  it("rides every trust-gated hook event, not just SessionStart", async () => {
    const file = rollout({ cli_version: "0.148.0-alpha.9" });
    for (const name of [
      "SessionStart",
      "PermissionRequest",
      "PostToolUse",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ]) {
      const ev = await normalizeCodexEvent(
        { ...hook(file), hook_event_name: name, source: "startup" },
        OPTS,
      );
      expect(ev.harness_version, name).toBe("0.148.0-alpha.9");
    }
  });

  it("carries nothing else out of the rollout (it also holds the user's prompts)", async () => {
    const file = rollout(
      { cli_version: "0.135.0", cwd: "/Users/alice/secret-dir" },
      `${JSON.stringify({ type: "message", text: "PRIVATE PROMPT" })}\n`,
    );
    const serialized = JSON.stringify(await normalizeCodexEvent(hook(file), OPTS));
    expect(serialized).toContain("0.135.0");
    expect(serialized).not.toContain("PRIVATE PROMPT");
    expect(serialized).not.toContain("secret-dir");
  });

  it("is omitted for a notify payload (no transcript path on that surface)", async () => {
    const ev = await normalizeCodexEvent(
      { type: "agent-turn-complete", "thread-id": "t", "turn-id": "u", cwd: CWD },
      OPTS,
    );
    expect(ev.harness_version).toBeUndefined();
  });

  it("fails soft on a missing / garbled / non-session_meta rollout", async () => {
    const missing = join(tmpdir(), "bb-cx-does-not-exist", "rollout.jsonl");
    expect((await normalizeCodexEvent(hook(missing), OPTS)).harness_version).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "bb-cx-rollout-"));
    rollouts.push(dir);
    const garbled = join(dir, "garbled.jsonl");
    writeFileSync(garbled, "{not json at all\n");
    expect((await normalizeCodexEvent(hook(garbled), OPTS)).harness_version).toBeUndefined();

    const wrongType = join(dir, "wrong.jsonl");
    writeFileSync(wrongType, `${JSON.stringify({ type: "message", cli_version: "9.9.9" })}\n`);
    expect((await normalizeCodexEvent(hook(wrongType), OPTS)).harness_version).toBeUndefined();
  });

  it("refuses a rollout whose first line never ends (never scans unbounded)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-cx-rollout-"));
    rollouts.push(dir);
    const huge = join(dir, "huge.jsonl");
    writeFileSync(
      huge,
      `{"type":"session_meta","payload":{"cli_version":"0.135.0","pad":"${"x".repeat(300_000)}"`,
    );
    expect((await normalizeCodexEvent(hook(huge), OPTS)).harness_version).toBeUndefined();
  });

  it("rejects a non-version cli_version instead of forwarding it", async () => {
    const file = rollout({ cli_version: "/Users/alice/.codex; rm -rf /" });
    const ev = await normalizeCodexEvent(hook(file), OPTS);
    expect(ev.harness_version).toBeUndefined();
    expect(JSON.stringify(ev)).not.toContain("rm -rf");
  });

  it("cliVersionFromRollout is the injectable production reader", async () => {
    const file = rollout({ cli_version: "0.135.0" });
    expect(cliVersionFromRollout(file)).toBe("0.135.0");
    const ev = await normalizeCodexEvent(hook("/nowhere/rollout.jsonl"), {
      ...OPTS,
      readRolloutVersion: () => "1.2.3",
    });
    expect(ev.harness_version).toBe("1.2.3");
  });
});

/**
 * gcgp.6: which SURFACE fired. Codex needs this most and gives it up least readily — the npm CLI
 * and the ChatGPT-bundled build share one config file, so the rollout `originator` is the only
 * thing that tells them apart. Both values below were captured from real rollouts on the machine
 * this landed on.
 */
describe("codexSurfaceFromPayload", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function rollout(name: string, meta: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "bb-surface-"));
    dirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: meta })}\n`);
    return path;
  }

  it("reads the npm install from the root it exports, without touching the disk", () => {
    expect(
      codexSurfaceFromPayload({ transcript_path: "/nope" }, { CODEX_MANAGED_PACKAGE_ROOT: "/x" }),
    ).toBe("terminal");
  });

  it("tells the ChatGPT-bundled build from the terminal CLI by the rollout originator", () => {
    const desktop = rollout("desk.jsonl", {
      cli_version: "0.148.0-alpha.9",
      originator: "Codex Desktop",
      source: "vscode",
    });
    const terminal = rollout("term.jsonl", {
      cli_version: "0.135.0",
      originator: "codex-tui",
      source: "cli",
    });
    expect(codexSurfaceFromPayload({ transcript_path: desktop }, {})).toBe("desktop");
    expect(codexSurfaceFromPayload({ transcript_path: terminal }, {})).toBe("terminal");
  });

  it("says nothing rather than guessing when the rollout is absent or unrecognized", () => {
    expect(codexSurfaceFromPayload({}, {})).toBeUndefined();
    expect(codexSurfaceFromPayload({ transcript_path: "/does/not/exist" }, {})).toBeUndefined();
    const odd = rollout("odd.jsonl", { cli_version: "1.0.0", originator: "something" });
    expect(codexSurfaceFromPayload({ transcript_path: odd }, {})).toBeUndefined();
  });
});
