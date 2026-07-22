#!/usr/bin/env node
/**
 * LIVE end-to-end proof for birdybeep-agent-fuf — the Codex `codex exec` exec-exit RACE.
 *
 * The bug: headless `codex exec` fires its `notify` program at turn-complete (right before it
 * exits) and then REAPS the notify child's PROCESS GROUP on exit. On a cold/slow backend the
 * in-line send was still in flight when the group was SIGKILLed, so the beep was lost before
 * delivery *or* the queue-write finished. The interactive `codex` TUI stays alive, so it never
 * hit this — the fix is scoped to the notify path.
 *
 * The fix (packages/cli/src/commands/hook.ts): a Codex notify fire re-launches the send
 * DETACHED (`detached: true` → setsid / new session), reading the payload from a strict-perm
 * temp file used as the worker's stdin, and the notify process returns immediately. The
 * detached worker is NOT in the group `codex exec` reaps, so it outlives the harness and
 * completes the send+queue. (The payload rides a temp file rather than a parent-held pipe so
 * the notify process holds no stream and exits instantly — a held pipe hung it on macOS.)
 *
 * This script proves that against the REAL built `birdybeep` binary — no mocks — WITHOUT
 * needing the `codex` binary or an OpenRouter key (unlike live-e2e-codex.mjs), because it
 * reproduces the reap directly: it spawns the real `birdybeep hook codex '<notify>'` in ITS
 * OWN process group (exactly how codex launches notify) against a deliberately SLOW stub
 * ingest, then SIGKILLs that group (exactly how `codex exec` reaps notify on exit).
 *
 * Two assertions, each of which the pre-fix code fails:
 *   1. FAST RETURN — the notify process returns in well under the backend's response time
 *      (it hands off + returns instead of blocking on the send). Pre-fix it blocked for the
 *      whole slow-backend round-trip, so it would still be running when codex reaps it.
 *   2. DELIVERY SURVIVES THE REAP — after the notify group is SIGKILLed, the event still
 *      arrives at the ingest, correctly normalized (agent_completed, hashed cwd, Bearer
 *      token, no raw content). Pre-fix the send lived in the reaped group and was lost.
 *
 * Requirements (SKIP with exit 2 when unmet, so it can sit in an always-on POSIX CI lane):
 *   - POSIX (process groups + kill(-pid)); skips on Windows
 *   - repo built (`pnpm build`) — needs packages/cli/dist/bin.js
 *
 * Run:  pnpm build && node scripts/live-e2e-codex-reap.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_BIN = join(REPO, "packages", "cli", "dist", "bin.js");
const AGENT_CORE_DIST = join(REPO, "packages", "agent-core", "dist", "index.js");
const TOKEN = "bbm_live_e2e_reap_token";

// Backend response delay: wide enough that a pre-fix IN-LINE send would still be blocked here
// when we reap, but the DETACHED worker (separate session) sails past the reap and completes.
const SINK_RESPONSE_DELAY_MS = 2500;
// The notify process MUST return well under the backend delay — proof it hands off, not blocks.
const FAST_RETURN_MS = 1500;
// Generous ceiling for the surviving worker's delivery to land at the ingest.
const DELIVER_DEADLINE_MS = 12_000;

const log = (msg) => console.log(`[live-e2e-codex-reap] ${msg}`);
function fail(msg) {
  console.error(`[live-e2e-codex-reap] FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function skip(msg) {
  console.error(`[live-e2e-codex-reap] SKIP: ${msg}`);
  process.exit(2);
}

// ── preconditions ────────────────────────────────────────────────────────────
if (process.platform === "win32") {
  // The reap is a POSIX process-group SIGKILL. On Windows a child is not killed when its
  // parent exits (see agent-core/src/safe-spawn.ts), so this race does not arise there; the
  // detach behavior itself is covered cross-platform by the hook.test.ts unit tests.
  skip("exec-exit reap is a POSIX process-group race (kill(-pid)); not applicable on Windows");
}
if (!existsSync(CLI_BIN)) skip(`CLI not built (${CLI_BIN}); run pnpm build`);

// ── sandbox layout ───────────────────────────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-reap-"));
const home = join(sandbox, "home");
const work = join(sandbox, "work");
const bin = join(sandbox, "bin");
for (const d of [home, work, bin]) mkdirSync(d, { recursive: true });

// The managed notify command invokes the bare `birdybeep`; the sandbox provides it as a
// wrapper around the freshly built CLI, exactly like a global install. `exec` so the wrapper
// shell is REPLACED by node — node becomes the process-group leader, matching how codex's
// notify child (and the group it reaps) actually looks.
writeFileSync(join(bin, "birdybeep"), `#!/bin/sh\nexec node "${CLI_BIN}" "$@"\n`);
chmodSync(join(bin, "birdybeep"), 0o755);
const BIRDYBEEP = join(bin, "birdybeep");

let sinkUrl = "";
const baseEnv = () => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  // bin on PATH so the notify process's OWN detached re-launch (safeSpawn resolves `birdybeep`
  // on PATH only) finds the wrapper.
  PATH: `${bin}:${process.env.PATH}`,
  BIRDYBEEP_API_URL: sinkUrl,
});

// ── slow stub ingest ─────────────────────────────────────────────────────────
// Records each POST body as soon as it arrives, then holds the RESPONSE for
// SINK_RESPONSE_DELAY_MS — long enough that a pre-fix in-line notify send would still be
// waiting here when we reap its group.
const received = [];
const pendingTimers = new Set();
const sink = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      /* keep raw */
    }
    received.push({ path: req.url, headers: req.headers, body });
    const t = setTimeout(() => {
      pendingTimers.delete(t);
      res.statusCode = 202;
      res.end(JSON.stringify({ accepted: true }));
    }, SINK_RESPONSE_DELAY_MS);
    pendingTimers.add(t);
  });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
sinkUrl = `http://127.0.0.1:${sink.address().port}`;
log(`slow stub ingest at ${sinkUrl} (response held ${SINK_RESPONSE_DELAY_MS}ms)`);

const cleanup = () => {
  for (const t of pendingTimers) clearTimeout(t);
  sink.close();
  rmSync(sandbox, { recursive: true, force: true });
};

try {
  // ── seed the machine token into the strict-perm FILE store under the sandbox HOME ──
  log("seed machine token (file store fallback)");
  const seed = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `const { setToken } = await import(${JSON.stringify(pathToFileURL(AGENT_CORE_DIST).href)});
       await setToken(${JSON.stringify(TOKEN)});`,
    ],
    { cwd: work, env: baseEnv(), encoding: "utf8" },
  );
  assert(seed.status === 0, `token seed failed: ${seed.stderr}`);

  // ── fire a real notify in its OWN process group, then reap the group ──────────
  const RAW_CWD = join(sandbox, "secret-codex-project");
  const SECRET = "sk-should-not-leak-abcdef0123456789";
  const notify = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "sess_reap_e2e",
    "turn-id": "turn1",
    cwd: RAW_CWD,
    client: "codex-exec",
    "input-messages": [`work in ${RAW_CWD}`],
    "last-assistant-message": `done ${SECRET}`,
  });

  log("fire real `birdybeep hook codex '<notify>'` in its own process group");
  const t0 = Date.now();
  // detached:true → the notify process is a group leader we can reap with kill(-pid), exactly
  // as `codex exec` reaps the notify child group on exit.
  const notifyProc = spawn(BIRDYBEEP, ["hook", "codex", notify, "--json"], {
    cwd: work,
    env: baseEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const notifyPid = notifyProc.pid;
  let stdout = "";
  let stderr = "";
  notifyProc.stdout.on("data", (d) => (stdout += d));
  notifyProc.stderr.on("data", (d) => (stderr += d));

  // Bound the wait so a REGRESSION (a notify that hangs instead of handing off + returning —
  // exactly what a held stdin pipe did on macOS) FAILS FAST here instead of hanging the CI job
  // for hours. The fix returns in ~100ms; a healthy in-line send would still finish within the
  // backend delay, so anything past a few × the backend delay is a genuine hang.
  const EXIT_WAIT_MS = SINK_RESPONSE_DELAY_MS + 5500; // 8s: well past both fast-return + in-line
  let exitTimer;
  const exited = once(notifyProc, "exit").then(([code]) => code);
  const timedOut = new Promise((r) => {
    exitTimer = setTimeout(() => r("timeout"), EXIT_WAIT_MS);
  });
  const exitCode = await Promise.race([exited, timedOut]);
  clearTimeout(exitTimer);
  const returnLatency = Date.now() - t0;
  if (exitCode === "timeout") {
    try {
      process.kill(-notifyPid, "SIGKILL"); // don't leave the hung process/group behind
    } catch {
      /* already gone */
    }
    fail(
      `notify process did not return within ${EXIT_WAIT_MS}ms — the fast-return handoff HUNG ` +
        `(regression: the notify process is being kept alive instead of detaching + returning). ` +
        `stdout so far: ${stdout.trim()} | stderr: ${stderr.trim()}`,
    );
  }
  log(
    `notify process exited (code ${exitCode}) after ${returnLatency}ms — stdout: ${stdout.trim()}`,
  );

  // Reap the notify PROCESS GROUP, precisely simulating `codex exec` tearing it down on exit.
  // The detached worker is in a SEPARATE session, so this must not stop the delivery.
  try {
    process.kill(-notifyPid, "SIGKILL");
    log(`reaped notify process group (kill(-${notifyPid}, SIGKILL))`);
  } catch (err) {
    // ESRCH is expected + fine: the group is already empty because the notify process returned
    // fast and the worker left to its own session. The point is proven either way.
    log(`process group already empty on reap (${err.code ?? err.message}) — as expected`);
  }

  // ── assertion 1: FAST RETURN (fail without the fix) ──────────────────────────
  assert(exitCode === 0, `notify process should exit 0, got ${exitCode}: ${stderr.trim()}`);
  assert(
    returnLatency < FAST_RETURN_MS,
    `notify blocked ${returnLatency}ms (≥ ${FAST_RETURN_MS}ms) against a ${SINK_RESPONSE_DELAY_MS}ms ` +
      `backend — it did not hand off the send; codex would reap it mid-send (the fuf bug)`,
  );
  assert(
    stdout.includes('"outcome":"detached"'),
    `expected the notify process to report outcome "detached"; got: ${stdout.trim()}`,
  );
  log(
    `✓ notify returned fast (${returnLatency}ms < ${FAST_RETURN_MS}ms) — it did not block on the send`,
  );

  // ── assertion 2: DELIVERY SURVIVES THE REAP (fail without the fix) ────────────
  log("await the detached worker's delivery to the ingest (survives the group reap)…");
  const deadline = Date.now() + DELIVER_DEADLINE_MS;
  while (Date.now() < deadline && received.length === 0) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(
    received.length >= 1,
    `no event delivered after the notify group was reaped — the send died with the group ` +
      `(the fuf bug is NOT fixed)`,
  );
  const events = received.filter((e) => e.path === "/v1/agent-events");
  assert(events.length === 1, `expected exactly one delivered event, got ${events.length}`);
  const e = events[0];

  assert(
    e.body.event_type === "agent_completed",
    `wrong event_type: ${e.body.event_type} (expected agent_completed from notify)`,
  );
  assert(e.body.harness === "codex", `wrong harness: ${e.body.harness}`);
  assert(
    e.headers.authorization === `Bearer ${TOKEN}`,
    `event not authed with the seeded token: ${e.headers.authorization}`,
  );
  assert(
    typeof e.body.workspace?.cwd === "string" && e.body.workspace.cwd.startsWith("h_"),
    `workspace.cwd not hashed: ${e.body.workspace?.cwd}`,
  );
  const bodyStr = JSON.stringify(e.body);
  assert(!bodyStr.includes(SECRET), "raw assistant content leaked into the delivered event body");
  assert(!bodyStr.includes(RAW_CWD), "raw cwd path leaked into the delivered event body");
  assert(!bodyStr.includes(TOKEN), "machine token leaked into the delivered event body");
  log("✓ event delivered AFTER the process-group reap — the detached worker survived");

  log("");
  log("PASS — codex notify survives the `codex exec` exec-exit reap (birdybeep-agent-fuf)");
} finally {
  cleanup();
}
