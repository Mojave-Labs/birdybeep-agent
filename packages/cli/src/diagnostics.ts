/**
 * Shared status/queue plumbing used by `birdybeep status` and `birdybeep doctor`: gather
 * each adapter's integration status, the machine identity + pairing state, and local queue
 * depth. Read-only + privacy-safe — never prints token material or notification bodies.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import {
  type AgentAdapter,
  type DetectionResult,
  getMachineIdentity,
  getToken,
  type IntegrationStatus,
  LocalEventQueue,
  readUnpairedNotice,
  type TokenStoreOptions,
  type UnpairedNotice,
} from "@birdybeep/agent-core";
import {
  BIRDYBEEP_HOOK_EVENTS as CLAUDE_HOOK_EVENTS,
  claudeSettingsPath,
  isBirdyBeepEntry as isClaudeEntry,
} from "@birdybeep/claude-code";
import {
  BIRDYBEEP_HOOK_EVENTS as CURSOR_HOOK_EVENTS,
  cursorHooksPath,
  detectCursor,
  isBirdyBeepEntry as isCursorEntry,
} from "@birdybeep/cursor";

export interface IntegrationState {
  harness: string;
  displayName: string;
  status: IntegrationStatus;
}

/** Each adapter's current §8.8 integration status (runs the real adapter.status()). */
export async function gatherIntegrations(adapters: AgentAdapter[]): Promise<IntegrationState[]> {
  return Promise.all(
    adapters.map(async (a) => ({
      harness: a.id,
      displayName: a.displayName,
      status: await a.status(),
    })),
  );
}

/** Is a machine token present in the secure store? (pairing state — never prints the token.) */
export async function isPaired(tokenOptions: TokenStoreOptions = {}): Promise<boolean> {
  return (await getToken(tokenOptions)) !== null;
}

/** Current local event-queue depth (fresh, non-expired entries). */
export function localQueueDepth(): number {
  return new LocalEventQueue().size();
}

/** How many events the queue's count cap has dropped on this machine (gcgp.4). */
export function localQueueOverflowDrops(): number {
  return new LocalEventQueue().overflowDropCount();
}

/**
 * Events that fired while this machine had no token, and were therefore never sent (gcgp.4).
 * `null` once the machine is paired — `pair` clears the notice.
 */
export function unpairedActivity(): UnpairedNotice | null {
  return readUnpairedNotice();
}

/** One line describing an unpaired-activity notice, for `status` / `doctor`. */
export function describeUnpairedActivity(notice: UnpairedNotice): string {
  const since = new Date(notice.firstAt).toISOString();
  const from = notice.harnesses.length > 0 ? ` from ${notice.harnesses.join(", ")}` : "";
  return `${notice.count} event(s)${from} fired since ${since} and were NOT sent — this machine is not paired.`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * How many of `events` carry a BirdyBeep-managed entry in a harness hooks config.
 * A missing file is 0; a file that cannot be parsed is `null` — a corrupt config is a
 * different failure, with its own check, and says nothing about what is installed.
 */
function birdyBeepHookCount(
  path: string,
  events: readonly string[],
  isBirdyBeepEntry: (entry: unknown) => boolean,
): number | null {
  if (!existsSync(path)) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const hooks = asRecord(asRecord(parsed)["hooks"]);
  let present = 0;
  for (const event of events) {
    const entries = hooks[event];
    if (Array.isArray(entries) && entries.some(isBirdyBeepEntry)) present += 1;
  }
  return present;
}

export interface CursorBridgeOptions {
  /** Override the home dir (default `os.homedir()`, which honors `$HOME`). */
  home?: string;
  /** Injectable Cursor detection for tests (avoids shelling out to `cursor-agent --version`). */
  detect?: () => Promise<DetectionResult>;
}

/**
 * Is Cursor reaching BirdyBeep ONLY through its Claude Code compatibility bridge (gcgp.13)?
 * True when Cursor is present, our Claude hooks are installed (the bridge reads
 * `~/.claude/settings.json` and runs them), and `~/.cursor/hooks.json` carries none of ours.
 * That machine gets lifecycle events attributed to Cursor but no approvals — the bridge drops
 * `Notification` and `PermissionRequest`. Read-only; cross-adapter, so it belongs to neither
 * adapter's own doctor(). False once the Cursor adapter is installed.
 */
export async function cursorBridgeOnly(opts: CursorBridgeOptions = {}): Promise<boolean> {
  const home = opts.home ?? homedir();
  const detection = await (opts.detect ?? (() => detectCursor({ home })))();
  if (!detection.detected) return false;
  const claude = birdyBeepHookCount(claudeSettingsPath(home), CLAUDE_HOOK_EVENTS, isClaudeEntry);
  if (claude === null || claude === 0) return false;
  return birdyBeepHookCount(cursorHooksPath(home), CURSOR_HOOK_EVENTS, isCursorEntry) === 0;
}

/** Machine label + OS (the event `machine` identity). */
export function machineIdentity(): { label: string; os: string } {
  return getMachineIdentity();
}
