/**
 * Real-shaped harness payloads — the EXACT JSON each coding harness emits, so an
 * adapter is exercised against reality, not a synthetic approximation. Claude Code
 * passes these objects as a single JSON line on the hook command's stdin
 * (verified against the official Claude Code hooks docs). Codex/OpenCode fixtures
 * are added by their adapter tickets in the same shape-faithful way.
 *
 * Fixtures deliberately embed an absolute `cwd`/`transcript_path` (must be hashed,
 * never sent raw) and an over-long `message` (must be truncated), so the contract
 * assertions have something real to bite on.
 */

/**
 * Fields present on every Claude Code hook payload. The index signature lets the
 * adapter read event-specific fields (message, stop_reason, …) generically while
 * keeping the common fields strongly typed — and lets concrete event interfaces
 * below extend it cleanly under `exactOptionalPropertyTypes`.
 */
export interface ClaudeCodeHookCommon {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  permission_mode?: string;
  [key: string]: unknown;
}

export interface ClaudeCodeNotification extends ClaudeCodeHookCommon {
  hook_event_name: "Notification";
  notification_type: string;
  message: string;
}

export interface ClaudeCodeStop extends ClaudeCodeHookCommon {
  hook_event_name: "Stop";
  stop_reason: string;
}

export interface ClaudeCodeSessionStart extends ClaudeCodeHookCommon {
  hook_event_name: "SessionStart";
  source: string;
  model?: string;
  session_title?: string;
}

/** A representative absolute project path — must be hashed before leaving the machine. */
const SAMPLE_CWD = "/Users/dev/projects/acme-payments-api";
const SAMPLE_TRANSCRIPT = "/Users/dev/.claude/transcripts/2026-06-14_001.jsonl";
const SAMPLE_SESSION = "sess_4b1c9f2e7a3d";

export const claudeCodeFixtures = {
  /** Permission prompt → maps to `approval_required` (§9.5). Long message exercises truncation. */
  notificationPermissionPrompt(): ClaudeCodeNotification {
    return {
      session_id: SAMPLE_SESSION,
      transcript_path: SAMPLE_TRANSCRIPT,
      cwd: SAMPLE_CWD,
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message:
        "Claude wants to run: `terraform apply -auto-approve` against the production workspace. " +
        "This will modify 14 resources including the primary RDS instance and the public ALB, and " +
        "destroy 2 resources (the legacy NAT gateway and an unused security group). Estimated apply " +
        "time is 6-9 minutes during which the API may briefly return 503s. Review the full plan output " +
        "above carefully before allowing — this action is not easily reversible and affects live traffic. " +
        "Allow? (y/n)",
    };
  },

  /** Turn finished → maps to `agent_completed` (§9.5). */
  stopEndTurn(): ClaudeCodeStop {
    return {
      session_id: SAMPLE_SESSION,
      transcript_path: SAMPLE_TRANSCRIPT,
      cwd: SAMPLE_CWD,
      hook_event_name: "Stop",
      permission_mode: "default",
      stop_reason: "end_turn",
    };
  },

  /** Session boot → maps to `session_started` (§9.5). */
  sessionStartStartup(): ClaudeCodeSessionStart {
    return {
      session_id: SAMPLE_SESSION,
      transcript_path: SAMPLE_TRANSCRIPT,
      cwd: SAMPLE_CWD,
      hook_event_name: "SessionStart",
      permission_mode: "default",
      source: "startup",
      model: "claude-sonnet-4-6",
      session_title: "Build payment flow",
    };
  },
};

/** The absolute paths a fixture embeds — handed to `assertPathsHashed` as "must not leak raw". */
export const FIXTURE_RAW_PATHS: readonly string[] = [SAMPLE_CWD, SAMPLE_TRANSCRIPT];
