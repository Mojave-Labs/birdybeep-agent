#!/usr/bin/env node
/**
 * LIVE end-to-end verification for the OpenCode adapter (§ CLAUDE.md "real
 * end-to-end testing"). Drives the REAL `opencode` binary end to end:
 *
 *   1. hermetic sandbox HOME (never touches the real machine)
 *   2. the BirdyBeep plugin is loaded into real OpenCode the way OpenCode actually
 *      loads local plugins — a file under ~/.config/opencode/plugin/ — pointed at
 *      the freshly built @birdybeep/opencode dist. (The published-package path,
 *      `"plugin": ["@birdybeep/opencode"]` in opencode.json, can't be exercised
 *      until the package is on npm; this proves the SAME plugin factory + hook
 *      path against the real event bus.)
 *   3. machine token seeded into the strict-perm FILE store (no keychain in CI)
 *   4. a real `opencode run` session against a cheap OpenRouter model, with
 *      `permission.bash = "ask"` so OpenCode fires a REAL permission.asked event
 *      (plus session.created / tool.execute.* / session.idle)
 *   5. each forwarded event spawns the real `birdybeep hook opencode` CLI; events
 *      must arrive at a local stub sink with the right types, Bearer token, hashed
 *      cwd, and NO raw command/content
 *   6. the headline assertion: approval_required IS delivered — the regression this
 *      guards (OpenCode renamed permission.updated → permission.asked; the old
 *      adapter forwarded the dead name and silently dropped every approval)
 *
 * Requirements (SKIP with exit 2 when unmet):
 *   - `opencode` on PATH (tested against opencode 1.18.x)
 *   - OPENROUTER_API_KEY or BIRDYBEEP_OPENROUTER_API_KEY env var
 *   - repo built (`pnpm build`)
 *
 * Run:  node scripts/live-e2e-opencode.mjs
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
const OPENCODE_PLUGIN_DIST = join(REPO, "packages", "opencode", "dist", "index.js");
const MODEL = process.env.BIRDYBEEP_E2E_MODEL ?? "openai/gpt-oss-120b";
const TOKEN = "bbm_live_e2e_opencode_token";
const OPENROUTER_KEY =
  process.env.OPENROUTER_API_KEY ?? process.env.BIRDYBEEP_OPENROUTER_API_KEY ?? "";

let step = 0;
const log = (msg) => console.log(`[live-e2e-opencode] ${msg}`);
const begin = (msg) => log(`step ${++step}: ${msg}`);
function fail(msg) {
  console.error(`[live-e2e-opencode] FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function skip(msg) {
  console.error(`[live-e2e-opencode] SKIP: ${msg}`);
  process.exit(2);
}

// ── preconditions ────────────────────────────────────────────────────────────
if (!existsSync(CLI_BIN)) skip(`CLI not built (${CLI_BIN}); run pnpm build`);
if (!existsSync(OPENCODE_PLUGIN_DIST)) skip(`opencode plugin not built (${OPENCODE_PLUGIN_DIST})`);
if (OPENROUTER_KEY === "") skip("OPENROUTER_API_KEY / BIRDYBEEP_OPENROUTER_API_KEY not set");
const ocVersion = spawnSync("opencode", ["--version"], { encoding: "utf8" });
if (ocVersion.status !== 0) skip("opencode binary not on PATH");
log(`opencode: ${ocVersion.stdout.trim()}`);

// ── sandbox layout ───────────────────────────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-live-opencode-"));
const home = join(sandbox, "home");
const work = join(sandbox, "work");
const bin = join(sandbox, "bin");
const ocConfigDir = join(home, ".config", "opencode");
const ocPluginDir = join(ocConfigDir, "plugin");
for (const d of [home, work, bin, ocPluginDir]) mkdirSync(d, { recursive: true });

writeFileSync(join(bin, "birdybeep"), `#!/bin/sh\nexec node "${CLI_BIN}" "$@"\n`);
chmodSync(join(bin, "birdybeep"), 0o755);

// Load the REAL built BirdyBeep plugin into OpenCode's local-plugin dir. This is
// the exact factory the published package exports; only the module resolution
// differs from the npm path.
writeFileSync(
  join(ocPluginDir, "birdybeep.js"),
  `export { BirdyBeepPlugin } from ${JSON.stringify(pathToFileURL(OPENCODE_PLUGIN_DIST).href)};\n`,
);

let sinkUrl = "";
const makeBaseEnv = () => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  PATH: `${bin}:${process.env.PATH}`,
  OPENROUTER_API_KEY: OPENROUTER_KEY,
  BIRDYBEEP_API_URL: sinkUrl,
});

function birdybeep(args, env = {}) {
  return spawnSync("node", [CLI_BIN, ...args, "--json"], {
    cwd: work,
    env: { ...makeBaseEnv(), ...env },
    encoding: "utf8",
  });
}
/**
 * Async spawn — REQUIRED for the opencode run: spawnSync would block the Node
 * event loop for the child's lifetime, starving the in-process stub sink so the
 * hooks' POSTs time out and get (falsely) queued + re-drained. Awaiting an async
 * child keeps the loop free to answer them in-band.
 */
async function runAsync(cmd, args, { env = {}, timeoutMs = 180_000 } = {}) {
  const child = spawn(cmd, args, {
    cwd: work,
    env: { ...makeBaseEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [code] = await once(child, "close");
  clearTimeout(killer);
  return { status: code, stdout: out, stderr: err };
}

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
  rmSync(sandbox, { recursive: true, force: true });
};

try {
  // ── 1. OpenCode config: model + require approval for bash so a real
  //       permission.asked fires. ─────────────────────────────────────────────
  begin("write OpenCode config (model + permission bash=ask)");
  writeFileSync(
    join(ocConfigDir, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: `openrouter/${MODEL}`,
        permission: { bash: "ask", edit: "ask" },
      },
      null,
      2,
    )}\n`,
  );

  // ── 2. seed the machine token into the FILE store ─────────────────────────
  begin("seed machine token (file store fallback)");
  const seed = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `const { setToken } = await import(${JSON.stringify(pathToFileURL(AGENT_CORE_DIST).href)});
       console.log("token store:", await setToken(${JSON.stringify(TOKEN)}));`,
    ],
    { env: makeBaseEnv(), encoding: "utf8" },
  );
  assert(seed.status === 0, `token seed failed: ${seed.stderr}`);
  log(seed.stdout.trim());

  // ── 3. status is needs_restart (plugin configured, not yet proven loaded) ──
  // The adapter reports needs_restart until a first real event proves the plugin
  // loaded. We drop the plugin file directly (not the opencode.json array), so
  // status detection may differ; assert only that install/status don't error.
  begin("birdybeep status runs clean");
  const st = birdybeep(["status"]);
  assert(st.status === 0, `status failed: ${st.stderr}`);

  // ── 4. real opencode run session, forcing a bash tool call ────────────────
  begin(`real opencode run session against ${MODEL} (async; sink stays live)`);
  const runOut = await runAsync(
    "opencode",
    ["run", "-m", `openrouter/${MODEL}`, "Use the bash tool to run exactly: echo hello"],
    { timeoutMs: 150_000 },
  );
  // opencode may exit non-zero when it rejects the (unanswered) permission in
  // headless mode; that's fine — the permission.asked event still fired.
  log(`opencode run exit=${runOut.status}`);

  // ── 5. await delivery ──────────────────────────────────────────────────────
  begin("await event delivery to the stub sink");
  const want = ["session_started", "approval_required"];
  const deadline = Date.now() + 20_000;
  const have = () => new Set(received.map((r) => r.body?.event_type));
  while (Date.now() < deadline && !want.every((w) => have().has(w))) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const events = received.filter((r) => r.path === "/v1/agent-events");
  const types = events.map((e) => e.body?.event_type);
  log(`delivered event types: ${JSON.stringify(types)}`);

  // ── 6. assertions ──────────────────────────────────────────────────────────
  assert(types.includes("session_started"), "session_started not delivered (session.created)");
  // THE regression guard: permission.asked → approval_required must be delivered.
  assert(
    types.includes("approval_required"),
    "approval_required NOT delivered — the permission.asked→approval_required path is broken " +
      "(this is exactly the permission.updated regression)",
  );

  for (const e of events) {
    assert(
      e.headers.authorization === `Bearer ${TOKEN}`,
      `event not authed with the seeded token: ${e.headers.authorization}`,
    );
    assert(e.body.harness === "opencode", `wrong harness: ${e.body.harness}`);
    assert(
      typeof e.body.workspace?.cwd === "string" && e.body.workspace.cwd.startsWith("h_"),
      `workspace.cwd not hashed: ${e.body.workspace?.cwd}`,
    );
  }
  const bodies = JSON.stringify(events.map((e) => e.body));
  assert(!bodies.includes("echo hello"), "raw command leaked into a delivered event body");
  assert(!bodies.includes(sandbox), "raw sandbox path leaked into a delivered event body");
  assert(!bodies.includes(TOKEN), "machine token leaked into an event body");
  assert(!bodies.includes(OPENROUTER_KEY), "OpenRouter key leaked into an event body");

  // The approval event carries only the safe discriminator, never the command.
  const approval = events.find((e) => e.body?.event_type === "approval_required");
  assert(approval.body.body === "Approval requested", "approval body is not the fixed safe string");
  assert(
    approval.body.metadata?.permission_type === "bash",
    `approval permission_type discriminator missing/wrong: ${JSON.stringify(approval.body.metadata)}`,
  );

  log("");
  log(`PASS — real opencode ${ocVersion.stdout.trim()} delivered ${events.length} events`);
  log(
    `       including approval_required (the permission.asked regression guard): ${JSON.stringify(types)}`,
  );
} finally {
  cleanup();
}
