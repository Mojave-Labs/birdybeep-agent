/**
 * `birdybeep hook <claude|codex|opencode|cursor>` (§9.2–9.3) — the hot-path entrypoint every
 * installed adapter config invokes when its harness fires a lifecycle event. It reads the
 * raw payload (from the trailing arg for Codex's notify argv, else from stdin), selects the
 * named harness's `runXHook` (normalize → redact/hash/truncate → dedup → send w/ short
 * timeout → queue-on-fail → opportunistic drain → fast return), and ALWAYS exits 0 so it
 * never errors the harness. The token is read by the sender from the secure store — never
 * from config — and notification content is never persisted (the adapters' normalizers
 * enforce that).
 *
 * Built as a factory so the sender + stdin reader are injectable: tests drive the full
 * dispatch → command → pipeline → stub-sink path hermetically, exactly like the adapter E2Es.
 */
import {
  createSender as defaultCreateSender,
  type HookResult,
  safeSpawn,
  type Sender,
} from "@birdybeep/agent-core";
import { runClaudeHook } from "@birdybeep/claude-code";
import { runCodexHook } from "@birdybeep/codex";
import { runCursorHook } from "@birdybeep/cursor";
import { runOpenCodeHook } from "@birdybeep/opencode";

import { resolveApiUrl } from "../config";
import { type Command, EXIT } from "../framework";

export type HarnessName = "claude" | "codex" | "opencode" | "cursor";

type HarnessRunner = (input: unknown, options: { sender: Sender }) => Promise<HookResult>;

const RUNNERS: Record<HarnessName, HarnessRunner> = {
  claude: runClaudeHook,
  codex: runCodexHook,
  opencode: runOpenCodeHook,
  cursor: runCursorHook,
};

export const HOOK_HARNESSES: readonly HarnessName[] = ["claude", "codex", "opencode", "cursor"];

/**
 * Hard cap on reading the payload — a misbehaving harness must never hang the hook.
 * 3s (was 2s, erm): a loaded machine can be slow to flush a pipe, and a timeout here
 * silently DROPS the event ("skipped"). BUDGET MATH: this cap and the sender's
 * DEFAULT_TOTAL_BUDGET_MS (5s) run SEQUENTIALLY and must sum comfortably under the 10s
 * hook timeout the adapters register, leaving headroom for Node startup — 3s + 5s + ~1s
 * startup < 10s. (5s + 5s summed to exactly the timeout: a slow start got the hook
 * SIGKILLed mid-send, which skips the queue-on-failure catch and loses the event.)
 */
export const STDIN_READ_TIMEOUT_MS = 3000;

/** Resolve to `fallback` if `promise` does not settle within `ms` (the timer is unref'd). */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    if (typeof timer.unref === "function") timer.unref();
    void promise.then(finish, () => finish(fallback));
  });
}

export function isHarnessName(value: string | undefined): value is HarnessName {
  return value === "claude" || value === "codex" || value === "opencode" || value === "cursor";
}

/** Run one hook fire: select the harness runner and execute via the shared pipeline. */
export function runHookCommand(
  harness: HarnessName,
  payload: unknown,
  sender: Sender,
): Promise<HookResult> {
  return RUNNERS[harness](payload, { sender });
}

/** Read process.stdin to EOF (the harness pipes a small JSON then closes); never throws. */
function readStdinDefault(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

/** Resolve the raw payload: the trailing arg (Codex notify argv) wins, else read stdin. */
export async function readHookPayload(
  args: string[],
  readStdin: () => Promise<string>,
): Promise<string> {
  return args[1] ?? (await readStdin());
}

/**
 * birdybeep-agent-fuf: `codex exec` (headless/one-shot) reaps the notify child's PROCESS
 * GROUP when it exits. Codex fires `notify` at turn-complete — right before it exits — so on
 * a cold/slow backend the in-line send is still in flight when the group is SIGKILLed, and
 * the event is lost before delivery *or* the queue-write finishes (the interactive `codex`
 * TUI stays alive, so it never hit this).
 *
 * The fix, scoped to the notify path only: instead of sending in-line, re-launch
 * `birdybeep hook codex` DETACHED (`safeSpawn` → `setsid`/new session on POSIX, new process
 * group on Windows) delivering the payload on STDIN, then return immediately. The detached
 * worker is NOT in the group `codex exec` reaps, so it outlives the harness and completes the
 * fast send+queue. Because the worker is invoked WITHOUT a trailing argv payload it reads
 * stdin and runs the ordinary in-process path below — it is never itself re-detached, so this
 * never recurses. Lifecycle `[[hooks.X]]` events are deliberately untouched: they arrive on
 * stdin and fire mid-session, not at exit.
 *
 * Returns true when the detached worker was launched (the notify process then returns fast);
 * false when `birdybeep` can't be resolved on PATH (`safeSpawn` returns null) or the spawn
 * throws — the caller then falls back to an in-line send, since a possibly-truncated best-
 * effort delivery still beats dropping the event outright.
 */
export function detachCodexNotifyWorker(payload: string): boolean {
  try {
    // SECURITY (sec-review-2026-07 H1): resolve `birdybeep` to an absolute path on PATH only
    // (never cwd — the harness's cwd is the attacker-controllable repo), exactly as the
    // OpenCode plugin does. `input` delivers the payload via a strict-perm temp file / stdin,
    // reliable across POSIX and a Windows `.cmd` shim.
    const child = safeSpawn("birdybeep", ["hook", "codex"], { input: payload, detached: true });
    if (child === null) return false; // not on PATH → caller sends in-line as a fallback
    child.on("error", () => {
      /* the detached worker failed to launch — best-effort, never surface to the harness */
    });
    child.unref(); // don't keep the notify process alive waiting on the worker
    return true;
  } catch {
    return false; // any spawn failure → in-line fallback (never throw into the harness)
  }
}

export interface HookCommandDeps {
  /** Build the sender (default: agent-core `createSender` with the resolved API URL). */
  createSender?: (baseUrl: string) => Sender;
  /** Read the raw payload from stdin (default: real process.stdin). */
  readStdin?: () => Promise<string>;
  /** Hard cap on the payload read (default {@link STDIN_READ_TIMEOUT_MS}); tests shrink it. */
  stdinTimeoutMs?: number;
  /**
   * Detach the Codex notify send into a process that survives `codex exec` reaping its group
   * (birdybeep-agent-fuf). Default {@link detachCodexNotifyWorker}; returns whether the
   * detached worker launched (true → the notify process returns fast; false → send in-line as
   * a fallback). Injectable so tests drive the branch without spawning a real process.
   */
  detachCodexNotify?: (payload: string) => boolean;
}

/** Build the `hook` command. Pure stubs aside, this is the live event path. */
export function createHookCommand(deps: HookCommandDeps = {}): Command {
  const makeSender = deps.createSender ?? ((baseUrl) => defaultCreateSender({ baseUrl }));
  const readStdin = deps.readStdin ?? readStdinDefault;
  const stdinTimeoutMs = deps.stdinTimeoutMs ?? STDIN_READ_TIMEOUT_MS;
  const detachCodexNotify = deps.detachCodexNotify ?? detachCodexNotifyWorker;

  return {
    name: "hook",
    summary: "Internal: normalize + send an event fired by a harness hook",
    usage: "birdybeep hook <claude|codex|opencode|cursor>",
    run: async (ctx) => {
      const harness = ctx.args[0];
      if (!isHarnessName(harness)) {
        ctx.io.errline(`birdybeep hook: expected one of ${HOOK_HARNESSES.join("|")}`);
        return EXIT.USAGE;
      }

      // birdybeep-agent-fuf: a Codex *notify* fire (payload delivered as the trailing argv
      // arg) races `codex exec` exit, which reaps the notify process group. Re-launch the send
      // DETACHED reading the payload on stdin (see {@link detachCodexNotifyWorker}) and return
      // immediately, so it outlives the reap. Scoped to notify only — lifecycle hooks arrive on
      // stdin. If the worker can't be launched we fall through and send in-line (best-effort).
      const notifyPayload = ctx.args[1];
      if (harness === "codex" && notifyPayload !== undefined && detachCodexNotify(notifyPayload)) {
        ctx.io.result({ harness, outcome: "detached" });
        return EXIT.OK; // the detached worker delivers; the notify process must not block codex
      }

      // Bounded read: the trailing argv payload resolves instantly; a hung/never-closing
      // stdin falls back to "" after the timeout so the hook ALWAYS returns fast (§9.3).
      const raw = await withTimeout(readHookPayload(ctx.args, readStdin), stdinTimeoutMs, "");
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        // Garbled/empty payload → skip silently + fast. Never error the harness.
        ctx.io.result({ harness, outcome: "skipped" });
        return EXIT.OK;
      }

      const sender = makeSender(resolveApiUrl());
      const result = await runHookCommand(harness, payload, sender);
      // Hot path: human mode is silent; --json emits the outcome for scripts/debugging.
      // Surface the backend's 202 decision (notified/suppressed/deduped) + HTTP status when
      // a send was attempted — the outcome alone ("delivered") can't distinguish a beep that
      // fired from one the backend accepted-but-suppressed, which is exactly the failure mode
      // `doctor` and delivery debugging need to see.
      ctx.io.result({
        harness,
        outcome: result.outcome,
        eventType: result.eventType,
        ...(result.send?.decision ? { decision: result.send.decision } : {}),
        ...(result.send?.status !== undefined ? { status: result.send.status } : {}),
      });
      return EXIT.OK; // delivered/queued/deduped/skipped all return fast + non-erroring
    },
  };
}
