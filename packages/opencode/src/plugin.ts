/**
 * The BirdyBeep OpenCode plugin (§9.7). OpenCode loads this at startup and calls the
 * exported factory with its `PluginInput`; we capture the workspace directory and return
 * the `Hooks` BirdyBeep registers:
 *   - the generic `event` bus hook → forwards the allow-listed session/permission lifecycle
 *     events (NOT high-frequency events like `message.part.updated` — that would flood);
 *   - the named `tool.execute.before` / `tool.execute.after` hooks.
 * Each handler builds a `{ type, properties, cwd }` envelope and hands it to the BirdyBeep
 * hook path (`birdybeep hook opencode`), which reads the token securely, normalizes,
 * redacts/truncates, sends with a short timeout, and queues on failure. Handlers are fast
 * and NEVER throw into OpenCode (§9.3). No durable token lives in the plugin or config —
 * the token stays in the CLI's secure store and is read at send time.
 *
 * `invokeHook` is injectable so tests (and OC-E2E) route through the in-process hook
 * runner + a stub sink; the default spawns the `birdybeep hook opencode` CLI command
 * (built in the a-cli epic) fire-and-forget.
 *
 * PATH (birdybeep-agent-gcgp.16): resolving `birdybeep` on PATH is the LAST resort, not the first.
 * Unlike every other adapter, this one writes no command string into a harness config — the spawn
 * happens here, at runtime, so a stripped PATH produced no exit-127 line in a hook log, just a
 * silent drop of every event with a single stderr breadcrumb nobody sees. Install records the
 * absolute launcher (Node + CLI entry) it resolved, and {@link defaultInvokeHook} prefers it.
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";

import { safeSpawn } from "@birdybeep/agent-core";

import { readOpenCodeLauncher } from "./install";

/** The envelope forwarded to the BirdyBeep hook path; `normalizeOpenCodeEvent` consumes it. */
export interface OpenCodeEventEnvelope {
  type: string;
  properties: unknown;
  /** Injected by the plugin from its PluginInput (most bus events don't carry cwd). */
  cwd: string;
}

/** Minimal structural shape of OpenCode's plugin input (only the fields BirdyBeep reads). */
export interface OpenCodePluginInput {
  directory?: string;
  worktree?: string;
}

interface BusEventInput {
  event?: { type: string; properties?: unknown };
}
interface ToolHookInput {
  tool?: string;
  sessionID?: string;
  callID?: string;
}

/** The subset of OpenCode `Hooks` BirdyBeep registers. */
export interface BirdyBeepHooks {
  event: (input: BusEventInput) => Promise<void>;
  "tool.execute.before": (input: ToolHookInput) => Promise<void>;
  "tool.execute.after": (input: ToolHookInput) => Promise<void>;
}

export interface BirdyBeepPluginDeps {
  /** Deliver one event envelope. Default: spawn `birdybeep hook opencode` (fire-and-forget). */
  invokeHook?: (envelope: OpenCodeEventEnvelope) => void | Promise<void>;
}

/**
 * Bus events we forward; high-frequency events (message.part.*, file.*) are excluded.
 *
 * Verified against real `opencode` 1.18.1 event traffic (2026-07-15), NOT a spec table:
 * the approval event is `permission.asked` (payload `{id, sessionID, permission, patterns,
 * metadata, always, tool}`) — an earlier SST SDK exposed `permission.updated`, which the
 * current Anomaly build no longer emits (§21.1 harness drift). Forwarding the stale name
 * silently dropped every approval, so OpenCode users got no "needs approval" beep.
 * `permission.replied` is intentionally NOT forwarded (the user's own reply, not an
 * agent-attention moment).
 */
export const FORWARDED_BUS_EVENTS: ReadonlySet<string> = new Set([
  "session.created",
  "session.updated",
  "session.status",
  "session.idle",
  "session.error",
  "permission.asked",
]);

/** Log a spawn failure ONCE per process — silent drops made every OpenCode event vanish
 * with no trace when the CLI couldn't spawn (erm). Metadata only: never the payload. */
let spawnFailureLogged = false;
function logSpawnFailureOnce(reason: string): void {
  if (spawnFailureLogged) return;
  spawnFailureLogged = true;

  console.error(
    `birdybeep: could not spawn the CLI to deliver an event (${reason}). ` +
      `Events from this OpenCode session are being dropped — re-run \`birdybeep agent install opencode\` ` +
      `(it records the CLI's absolute path, so OpenCode no longer has to find it on PATH), then \`birdybeep doctor\`.`,
  );
}

/**
 * Spawn the launcher install recorded — absolute Node running the absolute CLI entry (gcgp.16).
 * Returns false when there is no usable record, so the caller falls back to the PATH lookup.
 *
 * No shell and no PATH is consulted, which makes this strictly SAFER than the fallback as well as
 * more reliable: argv[0] is validated absolute + existing by `readOpenCodeLauncher`, so the
 * cwd-binary-planting hijack `safeSpawn` defends against (this plugin's cwd is the repo the
 * developer just opened) has nothing to resolve. cwd is forced to the Node binary's own directory
 * for the same reason — never the inherited, attacker-controlled one. And because argv[0] is a
 * real executable rather than a `.cmd` shim, stdin is a plain pipe on every platform: the Windows
 * batch-shim hand-off that forced safeSpawn's temp-file redirect cannot arise here.
 */
function spawnRecordedLauncher(payload: string): boolean {
  const argv = readOpenCodeLauncher();
  if (argv === null) return false;
  const [program, ...prefix] = argv as [string, ...string[]];
  const child = spawn(program, [...prefix, "hook", "opencode"], {
    cwd: dirname(program),
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });
  child.on("error", (err) => logSpawnFailureOnce(err.message)); // best-effort, never block
  child.stdin?.on("error", () => {
    /* child exited before we finished writing — best-effort, never throw */
  });
  try {
    child.stdin?.end(payload);
  } catch {
    /* stdin already torn down; the event is simply dropped */
  }
  child.unref(); // fire-and-forget: the hook outlives this OpenCode event
  return true;
}

/** Default delivery: hand the envelope to `birdybeep hook opencode` and return immediately. */
function defaultInvokeHook(envelope: OpenCodeEventEnvelope): void {
  try {
    // Prefer the absolute launcher install resolved: OpenCode may well have been started without
    // the user's shell PATH, and then the fallback below finds nothing at all.
    if (spawnRecordedLauncher(JSON.stringify(envelope))) return;
    // SECURITY (sec-review-2026-07 H1): we MUST NOT spawn the bare name `birdybeep`. This
    // plugin's cwd is the repo the developer just opened, and on Windows the OS resolver
    // (cmd.exe under `shell: true`, and libuv for a bare name) searches the CURRENT WORKING
    // DIRECTORY *before* PATH, applying PATHEXT — so a hostile repo shipping birdybeep.exe/
    // .cmd/.bat at its root would get executed on an ordinary lifecycle event. This is an
    // EXECUTABLE-RESOLUTION hijack (not argument injection): the payload riding stdin was
    // never the risk. `safeSpawn` resolves `birdybeep` to an ABSOLUTE path on PATH only
    // (never cwd) and launches that, so the planted binary is never reachable. A Windows
    // .cmd shim still needs a shell (Node ≥20 refuses .cmd without one, CVE-2024-27980), so
    // safeSpawn routes it through cmd.exe with the fully-qualified quoted path + a trusted
    // cwd + windowsHide. Fire-and-forget: detach so the hook outlives this OpenCode event.
    //
    // Deliver the envelope on STDIN via `input` (NOT a hand-written child.stdin pipe): a pipe
    // into a Windows `.cmd` through cmd.exe does not reliably reach the batch shim's `node`
    // grandchild, so every event silently dropped on Windows. `input` routes the payload
    // through a strict-perm temp file the CLI reads as stdin — reliable on all platforms.
    const child = safeSpawn("birdybeep", ["hook", "opencode"], {
      input: JSON.stringify(envelope),
      detached: true,
    });
    if (child === null) {
      // No recorded launcher AND `birdybeep` is not on PATH — drop the event (never a bare-name
      // fallback). One breadcrumb per process so this doesn't silently vanish (the old failure
      // mode, erm); after gcgp.16 it also means install has not run since the CLI last moved.
      logSpawnFailureOnce("no recorded launcher and `birdybeep` was not found on PATH");
      return;
    }
    child.on("error", (err) => logSpawnFailureOnce(err.message)); // best-effort, never block
    child.unref();
  } catch (err) {
    logSpawnFailureOnce(err instanceof Error ? err.message : String(err));
    /* never throw into OpenCode */
  }
}

/**
 * Build the BirdyBeep OpenCode plugin. The returned async function is what OpenCode loads
 * and invokes at startup with its PluginInput.
 */
export function createBirdyBeepPlugin(
  deps: BirdyBeepPluginDeps = {},
): (input: OpenCodePluginInput) => Promise<BirdyBeepHooks> {
  const invoke = deps.invokeHook ?? defaultInvokeHook;

  return function birdybeepPlugin(input: OpenCodePluginInput): Promise<BirdyBeepHooks> {
    const cwd = input.directory ?? input.worktree ?? "unknown";
    const forward = async (type: string, properties: unknown): Promise<void> => {
      try {
        await invoke({ type, properties, cwd });
      } catch {
        /* never surface as an OpenCode error (§9.3) */
      }
    };

    return Promise.resolve({
      event: async ({ event }) => {
        if (event !== undefined && FORWARDED_BUS_EVENTS.has(event.type)) {
          await forward(event.type, event.properties ?? {});
        }
      },
      "tool.execute.before": async (hook) => {
        await forward("tool.execute.before", {
          tool: hook.tool,
          sessionID: hook.sessionID,
          callID: hook.callID,
        });
      },
      "tool.execute.after": async (hook) => {
        await forward("tool.execute.after", {
          tool: hook.tool,
          sessionID: hook.sessionID,
          callID: hook.callID,
        });
      },
    });
  };
}

/**
 * The ready-to-load BirdyBeep plugin OpenCode invokes (default `birdybeep hook opencode`
 * delivery). This is the named export an OpenCode `plugin` config entry resolves to.
 */
export const BirdyBeepPlugin = createBirdyBeepPlugin();
