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
 * errors the harness. The exceptions all share one shape — the hook ran, sent NOTHING, and
 * had nothing to say about it, which is precisely what hid the Cursor-bridge drop for months.
 * Each now writes a stderr line and exits non-zero (a non-blocking error every harness
 * surfaces in its log): a payload no adapter recognizes (birdybeep-agent-gcgp.1), and an
 * absent, empty, unparseable or timed-out payload (birdybeep-agent-gcgp.14). A payload we DO
 * recognize but deliberately don't map stays a quiet exit 0.
 *
 * Built as a factory so the sender + stdin reader are injectable: tests drive the full
 * dispatch → command → pipeline → stub-sink path hermetically, exactly like the adapter E2Es.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createSender as defaultCreateSender,
  DEFAULT_SEND_TIMEOUT_MS,
  DEFAULT_TOTAL_BUDGET_MS,
  type HookResult,
  resolveOnPath,
  type Sender,
} from "@birdybeep/agent-core";
import { isClaudeCodeHookPayload, runClaudeHook } from "@birdybeep/claude-code";
import { isCodexHookPayload, runCodexHook } from "@birdybeep/codex";
import {
  type CopilotHookEventName,
  isCopilotHookEventName,
  isCopilotHookPayload,
  runCopilotHook,
} from "@birdybeep/copilot";
import { isCursorHookEventName, isCursorHookPayload, runCursorHook } from "@birdybeep/cursor";
import { isOpenCodeEventPayload, runOpenCodeHook } from "@birdybeep/opencode";

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
 * silently DROPS the event ("skipped"). A live healthy production ingest took 5.8s, so the
 * former 5s sender budget made the client abort and falsely queue already-accepted events.
 * {@link LEGACY_HOOK_RUNTIME_BUDGET_MS} clamps the later send so this read and the 8s sender
 * allowance never overrun a 10s hook left behind by a package-only upgrade.
 */
export const STDIN_READ_TIMEOUT_MS = 3000;

/**
 * Runtime available after the hook process starts, before returning control to the harness.
 *
 * Managed installs now use 15s, but an npm-only upgrade does not rewrite an existing 10s hook.
 * Keep every invocation inside that legacy deadline and reserve one second for Node startup,
 * queue persistence, output, and harness scheduling. Fast stdin still gets the full 8s sender
 * allowance; a slow stdin read reduces the send budget instead of letting the harness kill the
 * process before its timeout path can persist the event.
 */
export const LEGACY_HOOK_RUNTIME_BUDGET_MS = 9000;

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
 * driving this hook, and dropping it silently is the bug gcgp.1 was.
 *
 * All five harnesses answer now (birdybeep-agent-gcgp.14). Codex matters most — its `notify`
 * slot is a single-valued scalar that third-party tools also claim, so a chained tool handing
 * us an unfamiliar shape is a live possibility. Copilot matters differently: its payloads
 * carry no event discriminator (the event name is an argv argument), so a foreign payload did
 * not even skip — it normalized into a FABRICATED Copilot event and was sent.
 */
function recognizesPayload(harness: HarnessName, payload: unknown): boolean {
  switch (harness) {
    case "claude":
      return isClaudeCodeHookPayload(payload);
    case "cursor":
      return isCursorHookEventName(asRecord(payload)["hook_event_name"]);
    case "codex":
      return isCodexHookPayload(payload);
    case "opencode":
      return isOpenCodeEventPayload(payload);
    case "copilot":
      return isCopilotHookPayload(payload);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The payload's discriminating field for a diagnostic line — `hook_event_name` (Claude Code,
 * Codex hooks, Cursor), else `type` (Codex notify, OpenCode). Length-capped and JSON-quoted:
 * these are safe identifiers, but this is the one place hook output echoes the payload, so it
 * never grows unbounded and never reaches past that single field (no titles, no bodies, no
 * prompts). Copilot payloads have neither field — the caller gets "the payload".
 */
function describeDiscriminator(payload: unknown): string {
  const record = asRecord(payload);
  for (const field of ["hook_event_name", "type"] as const) {
    const value = record[field];
    if (typeof value !== "string") continue;
    const capped = value.length > 64 ? `${value.slice(0, 63)}…` : value;
    return `${field} ${JSON.stringify(capped)}`;
  }
  return "the payload";
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
  /** Build the sender with the wall-clock budget left for this invocation. */
  createSender?: (baseUrl: string, budgetMs: number) => Sender;
  /** Read the raw payload from stdin (default: real process.stdin). */
  readStdin?: () => Promise<string>;
  /** Hard cap on the payload read (default {@link STDIN_READ_TIMEOUT_MS}); tests shrink it. */
  stdinTimeoutMs?: number;
  /** Injectable monotonic clock for the legacy-hook budget tests. */
  now?: () => number;
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
  const makeSender =
    deps.createSender ??
    ((baseUrl: string, budgetMs: number) =>
      defaultCreateSender({
        baseUrl,
        timeoutMs: Math.min(DEFAULT_SEND_TIMEOUT_MS, budgetMs),
        totalBudgetMs: budgetMs,
      }));
  const readStdin = deps.readStdin ?? readStdinDefault;
  const stdinTimeoutMs = deps.stdinTimeoutMs ?? STDIN_READ_TIMEOUT_MS;
  const now = deps.now ?? (() => performance.now());
  const detachCodexNotify = deps.detachCodexNotify ?? detachCodexNotifyWorker;

  return {
    name: "hook",
    summary: "Internal: normalize + send an event fired by a harness hook",
    usage: "birdybeep hook <claude|codex|opencode|cursor|copilot> [copilot-event]",
    run: async (ctx) => {
      const hookStartedAt = now();
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
      // An empty trailing arg is not a real notify payload — fall through rather than spawning
      // a worker just to read an empty file; the empty-payload diagnostic below reports it.
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

      // Copilot's second arg is the event name, not a JSON payload. Every Copilot payload must
      // therefore come from stdin; Codex retains its notify argv-payload behavior.
      const copilotEventName =
        harness === "copilot" && isCopilotHookEventName(ctx.args[1]) ? ctx.args[1] : undefined;
      // birdybeep-agent-gcgp.14: without a usable event name the Copilot adapter cannot map
      // anything, and this returned `skipped` at exit 0 — a hook that fires, does nothing, and
      // says nothing. The installed config always passes one, so reaching here means the hook
      // entry was hand-edited or something else is invoking the command.
      if (harness === "copilot" && copilotEventName === undefined) {
        ctx.io.errline(
          `birdybeep hook copilot: second argument must be a Copilot hook event name, got ` +
            `${JSON.stringify(ctx.args[1] ?? "(none)")}. Nothing was sent.`,
        );
        return EXIT.USAGE;
      }

      // Bounded read: the trailing argv payload resolves instantly; a hung/never-closing
      // stdin falls back after the timeout so the hook ALWAYS returns fast (§9.3). The
      // fallback is `null` rather than "" so a timeout stays distinguishable from a harness
      // that closed stdin without writing — both are drops, and each names itself below.
      const read = await withTimeout<string | null>(
        readHookPayload(ctx.args, readStdin, harness === "copilot"),
        stdinTimeoutMs,
        null,
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

      // birdybeep-agent-gcgp.14: every branch below produced `skipped` at exit 0 with NO
      // output — the same invisible-drop shape as gcgp.1, and the one the 3s stdin cap turns
      // into a silent data loss on a loaded machine. Each now names itself on stderr and exits
      // non-zero. The payload itself is never echoed (it holds prompts, commands and tool
      // output); an unparseable one is described by BYTE LENGTH only.
      const drop = (reason: string, detail: string): number => {
        ctx.io.result({ harness, outcome: "skipped", reason });
        ctx.io.errline(`birdybeep hook ${harness}: ${detail}. Nothing was sent.`);
        return EXIT.ERROR;
      };
      if (read === null) {
        return drop(
          "stdin-timeout",
          `timed out after ${stdinTimeoutMs}ms waiting for the payload on stdin`,
        );
      }
      const raw = read;
      if (raw.trim().length === 0) {
        return drop("empty-payload", "the payload was empty");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return drop("invalid-json", `the ${raw.length}-byte payload is not valid JSON`);
      }

      // A foreign payload is handled by the harness it actually came from (see
      // resolveHookHarness) and reported as such, with `routedFrom` naming the hook that ran.
      const handler = resolveHookHarness(harness, payload);
      const routedFrom = handler !== harness ? { routedFrom: harness } : {};
      // birdybeep-agent-gcgp.1 + gcgp.14: a payload the handling adapter does not recognize
      // means something else is driving this hook. Checked BEFORE the pipeline runs, because
      // for Copilot "unmappable" is not the failure mode — its payloads carry no event
      // discriminator, so a foreign one normalizes cleanly and a fabricated event goes out.
      // A payload we DO recognize but don't map keeps its quiet exit 0 below.
      if (!recognizesPayload(handler, payload)) {
        ctx.io.result({
          harness: handler,
          ...routedFrom,
          outcome: "skipped",
          reason: "foreign-payload",
        });
        const article = handler === "opencode" ? "an" : "a"; // the only vowel-initial harness id
        ctx.io.errline(
          `birdybeep hook ${harness}: ${describeDiscriminator(payload)} is not ${article} ` +
            `${handler} hook event. Nothing was sent. Check which tool is running this hook.`,
        );
        return EXIT.ERROR;
      }

      // Package-only upgrades leave the already-installed hook's old 10s deadline untouched.
      // Account for time already spent reading and validating stdin, then give the sender only
      // the smaller of its normal 8s allowance and the legacy-safe remainder. The sender also
      // counts secure-store lookup against this budget, so it can queue before the harness kills
      // the process rather than losing the event between an 8s request and a 10s outer timeout.
      const elapsedMs = Math.max(0, now() - hookStartedAt);
      const budgetMs = Math.max(
        1,
        Math.min(DEFAULT_TOTAL_BUDGET_MS, LEGACY_HOOK_RUNTIME_BUDGET_MS - elapsedMs),
      );
      const sender = makeSender(resolveApiUrl(), budgetMs);
      const result = await runHookCommand(harness, payload, sender, copilotEventName);
      // Hot path: human mode is silent; --json emits the outcome for scripts/debugging.
      // Surface the backend's 202 decision (notified/suppressed/deduped) + HTTP status when
      // a send was attempted — the outcome alone ("delivered") can't distinguish a beep that
      // fired from one the backend accepted-but-suppressed, which is exactly the failure mode
      // `doctor` and delivery debugging need to see.
      ctx.io.result({
        harness: handler,
        ...routedFrom,
        ...(copilotEventName !== undefined ? { event: copilotEventName } : {}),
        outcome: result.outcome,
        eventType: result.eventType,
        ...(result.send?.decision ? { decision: result.send.decision } : {}),
        ...(result.send?.status !== undefined ? { status: result.send.status } : {}),
        ...(result.send?.queueCause !== undefined ? { queueCause: result.send.queueCause } : {}),
        ...(result.send?.tokenStoreUnavailable !== undefined ? { tokenStore: "unavailable" } : {}),
      });
      // birdybeep-agent-gcgp.4: an unpaired machine sent NOTHING and said NOTHING — the defect
      // that let 1138 events vanish over 18 hours. Say it on stderr (Cursor's hook log has a
      // STDERR section; Claude Code surfaces it), and note that `doctor` has the durable count,
      // because a bare hook command has no other way to reach the user. Exit stays 0: not being
      // paired is a BirdyBeep problem, and erroring the harness over it would be worse than the
      // silence. The durable half of this signal is the notice file agent-core just wrote.
      if (result.outcome === "unpaired") {
        ctx.io.errline(
          "birdybeep: this machine is not paired. The event was not sent or queued. " +
            "Run `birdybeep pair`, or run `birdybeep doctor` to see how many events were missed.",
        );
      }
      // 9u0: a retryable send is still lost when the queue cannot write it. Hooks remain exit 0
      // (BirdyBeep must not break the harness), but stderr and --json must not promise a retry.
      if (result.outcome === "failed") {
        ctx.io.errline(
          "birdybeep: the event could not be sent or saved locally. It will not retry. Check " +
            "that BirdyBeep can write to its user data directory, then run `birdybeep doctor`.",
        );
      }
      // birdybeep-agent-gcgp.23: the same line for a store that would not ANSWER would be a
      // wrong diagnosis — this machine may well be paired. Say what actually happened: the
      // event is queued and will go when the store is readable, so there is nothing to fix in
      // BirdyBeep and nothing lost. Exit stays 0 for the same reason as above.
      const unavailable =
        result.outcome === "queued" ? result.send?.tokenStoreUnavailable : undefined;
      if (unavailable !== undefined) {
        ctx.io.errline(
          `birdybeep: the machine token is unreadable (${unavailable.reason}). The event is ` +
            "queued. Restore token-store access; `birdybeep doctor` drains the queue.",
        );
      }
      // A recognized event we deliberately don't map stays quiet at exit 0, so normal
      // operation never gets noisier (gcgp.12: the deferred-but-real Claude Code events).
      return EXIT.OK; // delivered/queued/deduped/skipped all return fast + non-erroring
    },
  };
}
