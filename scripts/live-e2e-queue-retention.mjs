#!/usr/bin/env node
/**
 * LIVE end-to-end verification of queue retention on the NO-TOKEN path
 * (birdybeep-agent-87n) — § CLAUDE.md "real end-to-end testing". Reproduces the
 * observed field failure against the REAL `birdybeep` CLI binary, in real
 * subprocesses, in a hermetic sandbox HOME:
 *
 *   FIELD EVIDENCE: an UNPAIRED machine was found holding 457 queue entries whose
 *   oldest dated two weeks past the documented 24h retention window. Cause: the
 *   no-token path enqueued and returned without ever draining, and pruning lived
 *   only inside the drain/size read pass — so the queue grew one file per hook
 *   fire, forever, and retention was silently defeated.
 *
 * Steps:
 *   1. hermetic sandbox HOME (never touches the real machine)
 *   2. `birdybeep agent install claude` patches ~/.claude/settings.json
 *   3. NO token is seeded — this is an unpaired machine, the whole point
 *   4. seed 457 back-dated entries into the REAL queue dir (the field state)
 *   5. fire real Claude Code hook payloads through the real `birdybeep hook claude`
 *      binary, each in its own process, and watch the on-disk depth after every fire
 *   6. assert the queue COLLAPSES to just the fresh events and stays bounded across
 *      repeated fires, that every hook still exits 0 fast (never blocks the harness),
 *      and that nothing was sent to the sink while unpaired
 *   7. pair (seed a token) and assert the surviving backlog then DRAINS to the sink —
 *      i.e. retention pruning never ate a deliverable event
 *
 * Needs no backend and no model credentials: the no-token path makes no network
 * call at all, so this runs anywhere the repo is built (unlike the harness live-e2e
 * scripts, which need a real agent binary + OpenRouter key).
 *
 * CROSS-PLATFORM (birdybeep-agent-n02): the retention defect is not POSIX-specific and
 * the CLI ships on Windows, so this runs on all three OSes. Everything that used to
 * assume POSIX is gone: no `sh` PATH shim (it was dead weight — every child here is
 * spawned as `<node> <CLI_BIN>`, so nothing ever resolves `birdybeep` from PATH), no
 * `:`-joined PATH, `process.execPath` instead of a bare `node`, and the sandbox
 * redirects the Windows profile vars (USERPROFILE / LOCALAPPDATA / APPDATA / TEMP)
 * alongside HOME/XDG_*, because that is what `birdyBeepDataDir()` reads there.
 *
 * Run:  node scripts/live-e2e-queue-retention.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_BIN = join(REPO, "packages", "cli", "dist", "bin.js");
const AGENT_CORE_DIST = join(REPO, "packages", "agent-core", "dist", "index.js");
const TOKEN = "bbm_live_e2e_retention_token";
/** The field-observed backlog depth on the affected machine. */
const FIELD_BACKLOG = 457;
const DAY_MS = 24 * 60 * 60 * 1000;

let step = 0;
const log = (msg) => console.log(`[live-e2e-retention] ${msg}`);
const begin = (msg) => log(`step ${++step}: ${msg}`);
function fail(msg) {
  console.error(`[live-e2e-retention] FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function skip(msg) {
  console.error(`[live-e2e-retention] SKIP: ${msg}`);
  process.exit(2);
}

// ── preconditions ────────────────────────────────────────────────────────────
if (!existsSync(CLI_BIN)) skip(`CLI not built (${CLI_BIN}); run pnpm build`);
if (!existsSync(AGENT_CORE_DIST)) skip(`agent-core not built (${AGENT_CORE_DIST}); run pnpm build`);

// ── sandbox layout ───────────────────────────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-live-retention-"));
const home = join(sandbox, "home");
const work = join(sandbox, "work");
const temp = join(sandbox, "tmp");
for (const d of [home, work, temp, join(home, ".claude")]) mkdirSync(d, { recursive: true });

let sinkUrl = "";
/**
 * Redirect EVERY "where does my profile/config/data/temp live" variable into the sandbox,
 * on every OS — `birdyBeepDataDir()` reads `%LOCALAPPDATA%` on Windows, `$HOME` on macOS,
 * and `$XDG_DATA_HOME` on Linux, so a partial list would silently let one platform write
 * the queue into the REAL user profile.
 */
const makeBaseEnv = () => ({
  ...process.env,
  HOME: home, // macOS / Linux
  USERPROFILE: home, // Windows (os.homedir reads this)
  HOMEPATH: home, // Windows (legacy)
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"), // ← the Windows queue/token base
  TMPDIR: temp,
  TMP: temp,
  TEMP: temp,
  BIRDYBEEP_API_URL: sinkUrl,
});

function birdybeep(args) {
  // process.execPath, not a bare "node": no PATH lookup, and no `.exe`/shell quirks on win32.
  return spawnSync(process.execPath, [CLI_BIN, ...args, "--json"], {
    cwd: work,
    env: makeBaseEnv(),
    encoding: "utf8",
  });
}

/**
 * Async variant for any CLI call that must TALK to the stub sink: the sink runs in
 * this process, so a spawnSync would block its event loop and every send would time
 * out (indistinguishable from a real delivery failure). Use this whenever a command
 * drains the queue.
 */
async function birdybeepAsync(args) {
  const child = spawn(process.execPath, [CLI_BIN, ...args, "--json"], {
    cwd: work,
    env: makeBaseEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const [status] = await once(child, "close");
  clearTimeout(killer);
  return { status, stdout: out, stderr: err };
}

/**
 * Fire a REAL Claude Code hook the way the harness does: spawn `birdybeep hook claude`
 * as its own process and pipe the JSON payload on stdin. Async so the sink stays live.
 */
async function fireHook(payload) {
  const child = spawn(process.execPath, [CLI_BIN, "hook", "claude", "--json"], {
    cwd: work,
    env: makeBaseEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.end(JSON.stringify(payload));
  const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const started = Date.now();
  const [code] = await once(child, "close");
  clearTimeout(killer);
  return { status: code, stdout: out, stderr: err, elapsed: Date.now() - started };
}

/** Evaluate an expression inside a child process that sees the sandbox HOME. */
function inSandbox(body) {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", body], {
    env: makeBaseEnv(),
    encoding: "utf8",
  });
  assert(res.status === 0, `sandbox eval failed: ${res.stderr}`);
  return res.stdout.trim();
}

const CORE_URL = JSON.stringify(pathToFileURL(AGENT_CORE_DIST).href);
/** Absolute path of the REAL queue dir under the sandbox HOME (resolved by the shipped code). */
const queueDir = inSandbox(
  `const { LocalEventQueue } = await import(${CORE_URL});
   console.log(new LocalEventQueue().dir);`,
);
/** On-disk depth: count real queue files, not a pruning API (which would mask the bug). */
const depth = () =>
  existsSync(queueDir) ? readdirSync(queueDir).filter((n) => n.endsWith(".json")).length : 0;

// ── stub ingest sink ─────────────────────────────────────────────────────────
const received = [];
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
    res.statusCode = 202;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ accepted: true, decision: "notified" }));
  });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
sinkUrl = `http://127.0.0.1:${sink.address().port}`;
log(`stub sink listening at ${sinkUrl}`);

const cleanup = () => {
  sink.close();
  if (process.env.BIRDYBEEP_E2E_KEEP) {
    log(`BIRDYBEEP_E2E_KEEP set — leaving sandbox at ${sandbox}`);
    return;
  }
  // maxRetries: on Windows a just-exited child can still hold a handle for a beat (EBUSY).
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
};

const hookPayload = (i) => ({
  hook_event_name: "Stop",
  session_id: `live-retention-${i}`,
  transcript_path: join(work, "transcript.jsonl"),
  cwd: work,
});

try {
  // ── 1. real install ───────────────────────────────────────────────────────
  begin("birdybeep agent install claude (real install into sandbox HOME)");
  const install = birdybeep(["agent", "install", "claude"]);
  assert(install.status === 0, `install failed: ${install.stderr} ${install.stdout}`);
  log(`queue dir: ${queueDir}`);

  // ── 2. confirm the machine really is unpaired ─────────────────────────────
  begin("confirm NO token resolves (unpaired machine — the 87n precondition)");
  const tok = inSandbox(
    `const { getToken } = await import(${CORE_URL});
     console.log(JSON.stringify(await getToken()));`,
  );
  assert(tok === "null", `expected no token on a fresh sandbox, got ${tok}`);

  // ── 3. seed the observed field backlog, all back-dated past retention ──────
  begin(`seed ${FIELD_BACKLOG} back-dated queue entries (the observed field state)`);
  const seeded = inSandbox(
    `const { LocalEventQueue, normalizeEvent } = await import(${CORE_URL});
     // Two weeks stale, exactly like the machine in the field report.
     const stale = Date.now() - 14 * ${DAY_MS};
     const q = new LocalEventQueue({ now: () => stale });
     for (let i = 0; i < ${FIELD_BACKLOG}; i++) {
       q.enqueue(normalizeEvent({
         event_type: "agent_completed", harness: "claude_code", source_session_id: "seed" + i,
         machine: { label: "box", os: "linux" }, workspace: { cwd: ${JSON.stringify(work)} },
         status: "completed", title: "done", body: "ok",
       }));
     }
     console.log("seeded");`,
  );
  assert(seeded === "seeded", `seeding failed: ${seeded}`);
  assert(
    depth() === FIELD_BACKLOG,
    `expected ${FIELD_BACKLOG} seeded entries on disk, got ${depth()}`,
  );

  // ── 4. fire real hooks on the unpaired machine ────────────────────────────
  begin("fire 5 real `birdybeep hook claude` events with no token; watch on-disk depth");
  received.length = 0;
  const depths = [];
  for (let i = 0; i < 5; i++) {
    const r = await fireHook(hookPayload(i));
    assert(r.status === 0, `hook ${i} exited ${r.status}: ${r.stderr.slice(-400)}`);
    assert(r.elapsed < 5000, `hook ${i} took ${r.elapsed}ms — must never block the harness`);
    const parsed = JSON.parse(r.stdout);
    assert(parsed.outcome === "queued", `hook ${i} outcome ${parsed.outcome}, expected queued`);
    // NB: the hook's --json is a deliberately narrow debug surface (outcome/eventType/
    // decision/status) — the prune's DrainResult reaches `doctor`/`status` through
    // drainNow(), asserted in step 6. Here the on-disk depth is the real proof.
    depths.push(depth());
  }
  log(`on-disk depth after each fire: ${JSON.stringify(depths)}`);

  // ── 5. the assertions that fail on the pre-fix build ──────────────────────
  begin("assert the stale backlog was pruned and the queue stayed bounded");
  assert(
    depths[0] === 1,
    `first fire must collapse the ${FIELD_BACKLOG} expired entries to just its own event; got ${depths[0]}`,
  );
  assert(
    depths[depths.length - 1] === 5,
    `queue must hold only the 5 fresh events, got ${depths[depths.length - 1]}`,
  );
  assert(
    depths.every((d, i) => d === i + 1),
    `depth must track only fresh events (1..5), got ${JSON.stringify(depths)}`,
  );
  assert(
    depth() < FIELD_BACKLOG,
    "queue never shrank — retention is still defeated on the no-token path",
  );
  assert(received.length === 0, `unpaired machine sent ${received.length} requests; expected 0`);

  // ── 6. pairing drains what retention kept (pruning ate nothing live) ──────
  begin("seed a token, then `birdybeep status` drains the surviving backlog to the sink");
  const seedToken = inSandbox(
    `const { setToken, unavailableKeychainBackend } = await import(${CORE_URL});
     // File store, not the OS keychain: 'security add-generic-password' blocks headlessly.
     await setToken(${JSON.stringify(TOKEN)}, { backend: unavailableKeychainBackend });
     console.log("ok");`,
  );
  assert(seedToken === "ok", `token seed failed: ${seedToken}`);

  const status = await birdybeepAsync(["status"]);
  assert(status.status === 0, `status failed: ${status.stderr} ${status.stdout}`);
  const sj = JSON.parse(status.stdout);
  log(`status queue: ${JSON.stringify(sj.queue)}`);
  assert(sj.queue.depthBefore === 5, `expected 5 queued before drain, got ${sj.queue.depthBefore}`);
  assert(sj.queue.delivered === 5, `expected 5 delivered, got ${sj.queue.delivered}`);
  assert(
    sj.queue.depthAfter === 0,
    `expected an empty queue after drain, got ${sj.queue.depthAfter}`,
  );

  const events = received.filter((r) => r.path === "/v1/agent-events");
  assert(events.length === 5, `sink received ${events.length} events, expected 5`);
  for (const e of events) {
    assert(
      e.headers.authorization === `Bearer ${TOKEN}`,
      `event not authed with the seeded token: ${e.headers.authorization}`,
    );
    assert(e.body.harness === "claude_code", `wrong harness: ${e.body.harness}`);
    assert(
      typeof e.body.workspace?.cwd === "string" && e.body.workspace.cwd.startsWith("h_"),
      `workspace.cwd not hashed: ${e.body.workspace?.cwd}`,
    );
  }
  // No seeded (expired) event may be resurrected — retention drops, never delivers.
  const bodies = JSON.stringify(events.map((e) => e.body));
  assert(
    !bodies.includes("seed"),
    "an EXPIRED event was delivered — retention must drop, not send",
  );
  // `bodies` is JSON, so a Windows path appears with its backslashes DOUBLED — checking only
  // the raw form would make this leak assertion silently vacuous on win32.
  const sandboxInJson = JSON.stringify(sandbox).slice(1, -1);
  assert(
    !bodies.includes(sandbox) && !bodies.includes(sandboxInJson),
    "raw sandbox path leaked into a delivered event body",
  );
  assert(!bodies.includes(TOKEN), "machine token leaked into an event body");

  log("");
  log(
    `PASS — ${FIELD_BACKLOG} stale entries pruned on the first unpaired hook fire; ` +
      `depth stayed bounded at ${JSON.stringify(depths)} across 5 real hook processes; ` +
      `the 5 fresh events drained to the sink after pairing`,
  );
} finally {
  cleanup();
}
