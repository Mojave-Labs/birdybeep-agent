/**
 * `birdybeep hook <claude|codex|opencode|cursor|copilot>` (§9.2–9.3) — the hot-path entrypoint every
 * installed adapter config invokes when its harness fires a lifecycle event. It reads the
 * raw payload (from the trailing arg for Codex's notify argv, else from stdin), selects the
 * named harness's `runXHook` (normalize → redact/hash/truncate → dedup → send w/ short
 * timeout → queue-on-fail → opportunistic drain → fast return). The token is read by the
 * sender from the secure store — never from config — and notification content is never
 * persisted (the adapters' normalizers enforce that).
 *
 * Exit code is 0 for every normal outcome, including deliberate skips, so a hook fire never
 * errors the harness. The one exception (birdybeep-agent-gcgp.1) is a payload no adapter
 * recognizes: that sent nothing, so it exits non-zero with a stderr line instead of
 * disappearing — a non-blocking error every harness surfaces in its log.
 *
 * Built as a factory so the sender + stdin reader are injectable: tests drive the full
 * dispatch → command → pipeline → stub-sink path hermetically, exactly like the adapter E2Es.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  createSender as defaultCreateSender,
  type HookResult,
  resolveOnPath,
  type Sender,
} from "@birdybeep/agent-core";
import { isClaudeCodeHookPayload, runClaudeHook } from "@birdybeep/claude-code";
import { runCodexHook } from "@birdybeep/codex";
import {
  type CopilotHookEventName,
  isCopilotHookEventName,
  runCopilotHook,
} from "@birdybeep/copilot";
import { isCursorHookEventName, isCursorHookPayload, runCursorHook } from "@birdybeep/cursor";
import { runOpenCodeHook } from "@birdybeep/opencode";

import { resolveApiUrl } from "../config";
import { type Command, EXIT } from "../framework";

export type HarnessName = "claude" | "codex" | "opencode" | "cursor" | "copilot";

type HarnessRunner = (input: unknown, options: { sender: Sender }) => Promise<HookResult>;

const RUNNERS: Record<Exclude<HarnessName, "copilot">, HarnessRunner> = {
  claude: runClaudeHook,
  codex: runCodexHook,
  opencode: runOpenCodeHook,
  cursor: runCursorHook,
};

export const HOOK_HARNESSES: readonly HarnessName[] = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "copilot",
];

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
  return (
    value === "claude" ||
    value === "codex" ||
    value === "opencode" ||
    value === "cursor" ||
    value === "copilot"
  );
}

/**
 * Which harness's adapter should actually handle this payload.
 *
 * birdybeep-agent-gcgp.1: Cursor desktop's Claude Code compatibility bridge reads
 * `~/.claude/settings.json` and runs `birdybeep hook claude` with a CURSOR payload (lowercase
 * step names + `cursor_version`/`workspace_roots`). Sending that through the Claude normalizer
 * hit its `default:` throw, which the pipeline turns into `skipped` — every bridged event was
 * dropped, exit 0, no output. Route them to the Cursor adapter instead: they normalize
 * correctly AND are attributed to `harness: "cursor"`, so bridged traffic never masquerades as
 * Claude Code. Detection keys on fields Claude Code never sends, so a real Claude Code fire
 * can't be reclassified.
 */
export function resolveHookHarness(harness: HarnessName, payload: unknown): HarnessName {
  return harness === "claude" && isCursorHookPayload(payload) ? "cursor" : harness;
}

/**
 * Is this payload one the handling harness actually fires? A payload we recognize but don't
 * map is a deliberate skip (quiet); one we don't recognize at all means something else is
 * driving this hook, and dropping it silently is the bug gcgp.1 was. Only the two harnesses
 * that share a config surface answer this — the rest keep their existing quiet-skip behavior.
 */
function recognizesPayload(harness: HarnessName, payload: unknown): boolean {
  if (harness === "claude") return isClaudeCodeHookPayload(payload);
  if (harness === "cursor") return isCursorHookEventName(asRecord(payload)["hook_event_name"]);
  return true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The payload's `hook_event_name` for a diagnostic line. Length-capped and JSON-quoted: hook
 * event names are safe identifiers, but this is the one place hook output echoes the payload,
 * so it never grows unbounded and never reaches past that single field (no titles, no bodies).
 */
function describeEventName(payload: unknown): string {
  const name = asRecord(payload)["hook_event_name"];
  if (typeof name !== "string") return "(absent)";
  return JSON.stringify(name.length > 64 ? `${name.slice(0, 63)}…` : name);
}

/** Run one hook fire: select the harness runner and execute via the shared pipeline. */
export function runHookCommand(
  harness: HarnessName,
  payload: unknown,
  sender: Sender,
  copilotEventName?: CopilotHookEventName,
): Promise<HookResult> {
  const handler = resolveHookHarness(harness, payload);
  if (handler === "copilot") {
    if (copilotEventName === undefined) return Promise.resolve({ outcome: "skipped" });
    return runCopilotHook(copilotEventName, payload, { sender });
  }
  return RUNNERS[handler](payload, { sender });
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
  stdinOnly = false,
): Promise<string> {
  return stdinOnly ? readStdin() : (args[1] ?? (await readStdin()));
}

/**
 * Env var carrying the temp-file path the detached notify worker deletes after reading it —
 * see {@link detachCodexNotifyWorker}. Set only on the detached worker's environment.
 */
export const NOTIFY_STDIN_FILE_ENV = "BIRDYBEEP_CODEX_NOTIFY_STDIN_FILE";

/**
 * birdybeep-agent-fuf: `codex exec` (headless/one-shot) reaps the notify child's PROCESS
 * GROUP when it exits. Codex fires `notify` at turn-complete — right before it exits — so on
 * a cold/slow backend the in-line send is still in flight when the group is SIGKILLed, and
 * the event is lost before delivery *or* the queue-write finishes (the interactive `codex`
 * TUI stays alive, so it never hit this).
 *
 * The fix, scoped to the notify path only: instead of sending in-line, re-launch
 * `birdybeep hook codex` DETACHED (`detached: true` → `setsid`/new session) reading the
 * payload on stdin, then return immediately. The detached worker is NOT in the group
 * `codex exec` reaps, so it outlives the harness and completes the fast send+queue. Because
 * the worker is invoked WITHOUT a trailing argv payload it reads stdin and runs the ordinary
 * in-process path below — it is never itself re-detached, so this never recurses. Lifecycle
 * `[[hooks.X]]` events are deliberately untouched: they arrive on stdin and fire mid-session.
 *
 * The payload is delivered via a strict-perm (0o600) temp FILE handed to the worker as its
 * stdin fd — NOT a pipe this process holds. Two reasons: (1) the payload is fully written
 * before the spawn, so the worker always reads it complete even though we exit immediately;
 * (2) this process then holds NO pipe/stream to the child, so its prompt exit is DETERMINISTIC
 * on every platform — it never depends on when/whether a parent-held stdin pipe flushes and
 * closes, which is exactly the fast-return codex needs. The worker unlinks the temp file after
 * reading it (via {@link NOTIFY_STDIN_FILE_ENV}).
 *
 * Scoped to POSIX: on Windows a child is NOT killed when its parent exits (see agent-core
 * safe-spawn), so the exec-exit reap race does not arise there — we return false and the
 * caller sends in-line. We also return false when `birdybeep` can't be resolved on PATH or the
 * spawn throws; an in-line best-effort delivery still beats dropping the event outright.
 */
export function detachCodexNotifyWorker(payload: string): boolean {
  if (process.platform === "win32") return false; // no exec-exit reap race on Windows
  let file: string | undefined;
  let fd: number | undefined;
  try {
    // SECURITY (sec-review-2026-07 H1): resolve `birdybeep` to an absolute path on PATH ONLY
    // (never cwd — the harness's cwd is the attacker-controllable repo), then spawn that
    // absolute path with a trusted cwd. On POSIX `birdybeep` is a real executable (never a
    // shell shim), so no shell is involved.
    const birdybeep = resolveOnPath("birdybeep");
    if (birdybeep === null) return false; // not on PATH → caller sends in-line as a fallback

    const tmpFile = join(tmpdir(), `birdybeep-notify-${randomBytes(16).toString("hex")}.json`);
    file = tmpFile; // track for the synchronous catch cleanup path
    writeFileSync(tmpFile, payload, { mode: 0o600 }); // fully written BEFORE spawn
    fd = openSync(tmpFile, "r");
    const child = spawn(birdybeep, ["hook", "codex"], {
      cwd: dirname(birdybeep), // trusted dir, never the inherited/attacker cwd
      detached: true, // new session (setsid) → survives `codex exec` reaping the group
      stdio: [fd, "ignore", "ignore"], // stdin = the temp file; this process holds no pipe
      env: { ...process.env, [NOTIFY_STDIN_FILE_ENV]: tmpFile }, // worker cleans it up post-read
      windowsHide: true,
    });
    child.on("error", () => {
      // `spawn` reports most launch failures (EMFILE/ENOMEM, or the binary vanishing after
      // resolveOnPath) ASYNCHRONOUSLY via 'error', after we've already returned true. The worker
      // never ran, so it can't delete its stdin temp file — clean it up here so we don't leak a
      // 0o600 file per failed fire. The event itself is lost (we already returned; there's no
      // retroactive in-line send), which is the accepted best-effort contract for detachment.
      try {
        rmSync(tmpFile, { force: true });
      } catch {
        /* the OS reclaims tmp eventually */
      }
    });
    child.unref(); // don't keep the notify process alive waiting on the worker
    return true;
  } catch {
    if (file !== undefined) {
      try {
        rmSync(file, { force: true }); // spawn failed before the worker could clean up
      } catch {
        /* the OS reclaims tmp eventually */
      }
    }
    return false; // any failure → in-line fallback (never throw into the harness)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd); // the child holds its own dup; this process keeps no fd
      } catch {
        /* already closed / never opened */
      }
    }
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
    usage: "birdybeep hook <claude|codex|opencode|cursor|copilot> [copilot-event]",
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
      // An empty trailing arg is not a real notify payload — fall through so it's `skipped`
      // in-line rather than spawning a worker just to read an empty file.
      const notifyPayload = ctx.args[1];
      if (
        harness === "codex" &&
        notifyPayload !== undefined &&
        notifyPayload.length > 0 &&
        detachCodexNotify(notifyPayload)
      ) {
        ctx.io.result({ harness, outcome: "detached" });
        return EXIT.OK; // the detached worker delivers; the notify process must not block codex
      }

      // Bounded read: the trailing argv payload resolves instantly; a hung/never-closing
      // stdin falls back to "" after the timeout so the hook ALWAYS returns fast (§9.3).
      // Copilot's second arg is the event name, not a JSON payload. Every Copilot payload must
      // therefore come from stdin; Codex retains its notify argv-payload behavior.
      const copilotEventName =
        harness === "copilot" && isCopilotHookEventName(ctx.args[1]) ? ctx.args[1] : undefined;
      const raw = await withTimeout(
        readHookPayload(ctx.args, readStdin, harness === "copilot"),
        stdinTimeoutMs,
        "",
      );

      // If we ARE the detached notify worker (spawned by detachCodexNotifyWorker), the payload
      // was handed to us as a strict-perm temp file used for stdin — now that it's read, delete
      // it. Guard the path (our own tmpdir prefix) before unlinking so a stray/injected env value
      // can never make a hook fire force-delete an arbitrary file. Best-effort: the OS reclaims
      // tmp anyway, and a stale file is never a correctness bug.
      const notifyStdinFile = process.env[NOTIFY_STDIN_FILE_ENV];
      if (
        notifyStdinFile !== undefined &&
        dirname(notifyStdinFile) === tmpdir() &&
        basename(notifyStdinFile).startsWith("birdybeep-notify-")
      ) {
        try {
          rmSync(notifyStdinFile, { force: true });
        } catch {
          /* the OS reclaims tmp eventually */
        }
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        // Garbled/empty payload → skip silently + fast. Never error the harness.
        ctx.io.result({ harness, outcome: "skipped" });
        return EXIT.OK;
      }

      const sender = makeSender(resolveApiUrl());
      // A foreign payload is handled by the harness it actually came from (see
      // resolveHookHarness) and reported as such, with `routedFrom` naming the hook that ran.
      const handler = resolveHookHarness(harness, payload);
      const result = await runHookCommand(harness, payload, sender, copilotEventName);
      // Hot path: human mode is silent; --json emits the outcome for scripts/debugging.
      // Surface the backend's 202 decision (notified/suppressed/deduped) + HTTP status when
      // a send was attempted — the outcome alone ("delivered") can't distinguish a beep that
      // fired from one the backend accepted-but-suppressed, which is exactly the failure mode
      // `doctor` and delivery debugging need to see.
      ctx.io.result({
        harness: handler,
        ...(handler !== harness ? { routedFrom: harness } : {}),
        ...(copilotEventName !== undefined ? { event: copilotEventName } : {}),
        outcome: result.outcome,
        eventType: result.eventType,
        ...(result.send?.decision ? { decision: result.send.decision } : {}),
        ...(result.send?.status !== undefined ? { status: result.send.status } : {}),
      });
      // birdybeep-agent-gcgp.1: a payload no adapter recognizes sent NOTHING, and a silent
      // exit 0 is what hid the Cursor-bridge drop for months. Say so on stderr (harnesses log
      // it — Cursor's hook log has a STDERR section, Claude Code shows it to the user) and
      // exit non-zero so it registers as a failure. Deliberate skips — a recognized event we
      // don't map, an empty/garbled payload — stay quiet and exit 0 as before, so normal
      // operation never gets noisier.
      if (result.outcome === "skipped" && !recognizesPayload(handler, payload)) {
        ctx.io.errline(
          `birdybeep hook ${harness}: hook_event_name ${describeEventName(payload)} is not a ` +
            `${handler} hook event — nothing was sent. Check which tool is running this hook.`,
        );
        return EXIT.ERROR;
      }
      return EXIT.OK; // delivered/queued/deduped/skipped all return fast + non-erroring
    },
  };
}
