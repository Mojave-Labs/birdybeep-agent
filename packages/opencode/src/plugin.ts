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
 */
import { spawn } from "node:child_process";

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

/** Bus events we forward (verified §9.7 lifecycle names); high-frequency events are excluded. */
export const FORWARDED_BUS_EVENTS: ReadonlySet<string> = new Set([
  "session.created",
  "session.updated",
  "session.status",
  "session.idle",
  "session.error",
  "permission.updated",
]);

/** Log a spawn failure ONCE per process — silent drops made every OpenCode event vanish
 * with no trace when the CLI couldn't spawn (erm). Metadata only: never the payload. */
let spawnFailureLogged = false;
function logSpawnFailureOnce(reason: string): void {
  if (spawnFailureLogged) return;
  spawnFailureLogged = true;
  // eslint-disable-next-line no-console -- deliberate, once-per-process diagnosability breadcrumb
  console.error(
    `birdybeep: could not spawn the CLI to deliver an event (${reason}). ` +
      `Events from this OpenCode session are being dropped — check that \`birdybeep\` is on PATH and run \`birdybeep doctor\`.`,
  );
}

/** Default delivery: hand the envelope to `birdybeep hook opencode` and return immediately. */
function defaultInvokeHook(envelope: OpenCodeEventEnvelope): void {
  try {
    // Windows npm installs expose the CLI as a `birdybeep.cmd` shim; Node ≥20 refuses to
    // spawn .cmd/.bat without a shell (CVE-2024-27980 hardening), and spawning the bare
    // name without `shell` fails with ENOENT/EINVAL — which the old swallow-everything
    // handler turned into 100% silent event loss on Windows (erm). The command string is
    // a constant (the payload rides stdin), so `shell: true` adds no injection surface.
    const win = process.platform === "win32";
    const child = win
      ? spawn("birdybeep hook opencode", { stdio: ["pipe", "ignore", "ignore"], shell: true })
      : spawn("birdybeep", ["hook", "opencode"], {
          stdio: ["pipe", "ignore", "ignore"],
          detached: true,
        });
    child.on("error", (err) => logSpawnFailureOnce(err.message)); // best-effort, never block
    child.stdin?.end(JSON.stringify(envelope));
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
