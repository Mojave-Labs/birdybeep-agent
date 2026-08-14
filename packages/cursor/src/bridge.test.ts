/**
 * birdybeep-agent-gcgp.1 regression proof: Cursor desktop's Claude Code compatibility bridge
 * runs `birdybeep hook claude` with a CURSOR payload. Before the fix those lowercase step
 * names fell through the Claude normalizer's `default:` throw and every bridged event was
 * dropped with exit 0. These lock in that the payloads are RECOGNIZED as Cursor's and
 * normalize correctly — attributed to `harness: "cursor"`, PII still dropped.
 *
 * Payloads are the ones captured verbatim from Cursor 3.14.27's own hook log (see
 * `__fixtures__/README.md`), redacted only for PII/paths.
 */
import { birdyBeepAgentEventSchema } from "@birdybeep/agent-core";
import { describe, expect, it } from "vitest";

import bridgeSessionStart from "./__fixtures__/bridge-claude-sessionStart.json";
import bridgeStop from "./__fixtures__/bridge-claude-stop.json";
import nativeSessionEnd from "./__fixtures__/sessionEnd.json";
import nativeSessionStart from "./__fixtures__/sessionStart.json";
import { CURSOR_HOOK_EVENTS, isCursorHookEventName, isCursorHookPayload } from "./bridge";
import { normalizeCursorEvent } from "./normalize";

const DET = { now: () => "2026-08-07T00:00:00.000Z", generateId: () => "evt_fixed" };
const RAW_CWD = "/home/user/project";
const RAW_EMAIL = "user@example.com";

// Real Claude Code payload shapes — the bridge detector must never claim one of these.
const CLAUDE_PAYLOADS: Record<string, unknown>[] = [
  { hook_event_name: "SessionStart", session_id: "s1", cwd: RAW_CWD, source: "startup" },
  { hook_event_name: "Stop", session_id: "s1", cwd: RAW_CWD, last_assistant_message: "done" },
  { hook_event_name: "PermissionRequest", session_id: "s1", cwd: RAW_CWD, tool_name: "Bash" },
  { hook_event_name: "SessionEnd", session_id: "s1", cwd: RAW_CWD, reason: "clear" },
];

describe("isCursorHookPayload", () => {
  it("recognizes the payloads Cursor's Claude bridge feeds to `hook claude`", () => {
    expect(isCursorHookPayload(bridgeSessionStart)).toBe(true);
    expect(isCursorHookPayload(bridgeStop)).toBe(true);
    // The captured payloads really do use Cursor's lowercase step names, not Claude's.
    expect(bridgeSessionStart.hook_event_name).toBe("sessionStart");
    expect(bridgeStop.hook_event_name).toBe("stop");
  });

  it("recognizes Cursor's own (non-bridged) payloads too", () => {
    expect(isCursorHookPayload(nativeSessionStart)).toBe(true);
    expect(isCursorHookPayload(nativeSessionEnd)).toBe(true);
  });

  it("never claims a Claude Code payload", () => {
    for (const payload of CLAUDE_PAYLOADS) expect(isCursorHookPayload(payload)).toBe(false);
  });

  it("needs a Cursor-only marker, not just a lowercase name", () => {
    expect(isCursorHookPayload({ hook_event_name: "stop" })).toBe(false);
    // conversation_id alone is not enough; paired with workspace_roots it is.
    expect(isCursorHookPayload({ hook_event_name: "stop", conversation_id: "c1" })).toBe(false);
    expect(
      isCursorHookPayload({ hook_event_name: "stop", conversation_id: "c1", workspace_roots: [] }),
    ).toBe(true);
  });

  it("rejects non-payloads", () => {
    for (const value of [undefined, null, 42, "stop", [], {}]) {
      expect(isCursorHookPayload(value)).toBe(false);
    }
  });

  it("knows the bridge's target steps", () => {
    // Cursor's bridge maps Claude events onto these steps; Notification and PermissionRequest
    // are unsupported by the bridge, so they never arrive at all.
    for (const step of [
      "preToolUse",
      "postToolUse",
      "beforeSubmitPrompt",
      "stop",
      "subagentStop",
      "sessionStart",
      "sessionEnd",
      "preCompact",
    ]) {
      expect(CURSOR_HOOK_EVENTS, `missing ${step}`).toContain(step);
      expect(isCursorHookEventName(step)).toBe(true);
    }
    expect(isCursorHookEventName("SessionStart")).toBe(false); // Claude's capitalized spelling
    expect(isCursorHookEventName(undefined)).toBe(false);
  });
});

describe("bridged payloads normalize as Cursor events", () => {
  it("sessionStart → session_started, harness cursor, PII dropped", async () => {
    const ev = await normalizeCursorEvent(bridgeSessionStart, DET);
    expect(birdyBeepAgentEventSchema.safeParse(ev).success).toBe(true);
    expect(ev.event_type).toBe("session_started");
    expect(ev.status).toBe("starting");
    expect(ev.harness).toBe("cursor"); // NOT claude_code — bridged traffic is attributed honestly
    expect(ev.source_session_id).toBe(bridgeSessionStart.session_id);
    expect(ev.harness_version).toBe("3.14.27");
    const wire = JSON.stringify(ev);
    expect(wire).not.toContain(RAW_EMAIL);
    expect(wire).not.toContain(RAW_CWD);
  });

  it("stop → agent_completed, harness cursor, transcript path dropped", async () => {
    const ev = await normalizeCursorEvent(bridgeStop, DET);
    expect(birdyBeepAgentEventSchema.safeParse(ev).success).toBe(true);
    expect(ev.event_type).toBe("agent_completed"); // the completion beep the bug swallowed
    expect(ev.status).toBe("completed");
    expect(ev.harness).toBe("cursor");
    const wire = JSON.stringify(ev);
    expect(wire).not.toContain(RAW_EMAIL);
    expect(wire).not.toContain(bridgeStop.transcript_path);
  });
});
