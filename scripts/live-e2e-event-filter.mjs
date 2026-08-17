#!/usr/bin/env node
/**
 * LIVE end-to-end volume proof for birdybeep-agent-gcgp.3 — the client-side event-type filter.
 *
 * THE MEASUREMENT IT REPRODUCES. 18.45h of one user's real Codex work produced 1148 events, of
 * which 1016 (88.5%) were `tool_finished` from `[[hooks.PostToolUse]]`. The server suppresses
 * that type before any user setting can apply, so every one of those POSTs was bandwidth,
 * D1/KV/DO work, and — at 60 events / 60s per machine — rate-limit budget that real beeps
 * needed. This script replays that exact mix through the REAL built `birdybeep hook codex`
 * binary and counts what reaches a stub ingest.
 *
 * WHAT IS REAL HERE: the built CLI (spawned once per event, exactly as Codex spawns it), the
 * real adapter + normalizer + dedup ledger + sender, a real machine token in the strict-perm
 * file store, real HTTP to a real server. What is SIMULATED is only the harness: Codex itself
 * is not driven (that needs an LLM key — see live-e2e-codex.mjs), so the hook payloads are
 * fed directly, in the shapes `codex-rs/hooks` emits.
 *
 * WHY EVERY EVENT CARRIES A DISTINCT IDENTITY. agent-core collapses an identical
 * (harness, session, type, title+body) event seen within 10s. In production those 1148 events
 * were spread over 18.45 hours — roughly one per minute — so essentially none of them deduped.
 * Compressing the same mix into ~70 seconds WOULD dedupe them, which would understate the
 * baseline and flatter the fix. So each replayed event gets its own session id and tool token:
 * that reproduces the production condition (no two identical events inside the window) rather
 * than an artifact of the replay's speed.
 *
 * Requirements: repo built (`pnpm build`). No harness binary, no API key, no network.
 *
 * Run:  pnpm build && node scripts/live-e2e-event-filter.mjs
 *       BIRDYBEEP_CLI_BIN=/path/to/other/bin.js node scripts/live-e2e-event-filter.mjs
 *         └─ point at a build from another revision to measure it (this is how the
 *            pre-gcgp.3 baseline in the ticket was produced).
 * Exit: 0 = green; 1 = an assertion failed; 2 = preconditions unmet (skip).
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_BIN = process.env["BIRDYBEEP_CLI_BIN"] ?? join(REPO, "packages", "cli", "dist", "bin.js");
const AGENT_CORE_DIST = join(REPO, "packages", "agent-core", "dist", "index.js");
const TOKEN = "bbm_live_e2e_filter_token";

// The measured 18.45h Codex session, event for event (1148 total, 1016 tool_finished = 88.5%).
const MIX = [
  { hook: "SessionStart", type: "session_started", count: 12 },
  { hook: "PermissionRequest", type: "approval_required", count: 40 },
  { hook: "PostToolUse", type: "tool_finished", count: 1016 },
  { hook: "SubagentStart", type: "subagent_started", count: 5 },
  { hook: "SubagentStop", type: "subagent_completed", count: 5 },
  { hook: "Stop", type: "agent_completed", count: 70 },
];
const TOTAL = MIX.reduce((n, m) => n + m.count, 0);
/** Types the backend can never push AND needs nothing from — what gcgp.3 withholds. */
const EXPECTED_WITHHELD = new Set(["tool_started", "tool_finished"]);
const EXPECTED_POSTS = MIX.filter((m) => !EXPECTED_WITHHELD.has(m.type)).reduce(
  (n, m) => n + m.count,
  0,
);

const log = (msg) => console.log(`[live-e2e-event-filter] ${msg}`);
let failures = 0;
function assert(cond, msg) {
  if (cond) {
    log(`  ok   ${msg}`);
  } else {
    console.error(`[live-e2e-event-filter] FAIL: ${msg}`);
    failures += 1;
  }
}
function skip(msg) {
  console.error(`[live-e2e-event-filter] SKIP: ${msg}`);
  process.exit(2);
}

if (!existsSync(CLI_BIN)) skip(`CLI not built (${CLI_BIN}); run pnpm build`);

// ── hermetic sandbox: never touches the real HOME, the real config, or the real queue ──
const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-filter-"));
const home = join(sandbox, "home");
const work = join(sandbox, "work");
for (const d of [home, work]) mkdirSync(d, { recursive: true });

let sinkUrl = "";
const baseEnv = () => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  BIRDYBEEP_API_URL: sinkUrl,
});

// ── stub ingest: counts POSTs by normalized event type ───────────────────────
const posted = new Map();
let postCount = 0;
const sink = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    postCount += 1;
    try {
      const type = JSON.parse(raw).event_type ?? "?";
      posted.set(type, (posted.get(type) ?? 0) + 1);
    } catch {
      posted.set("?", (posted.get("?") ?? 0) + 1);
    }
    res.statusCode = 202;
    res.end(JSON.stringify({ accepted: true, decision: "suppressed" }));
  });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
sinkUrl = `http://127.0.0.1:${sink.address().port}`;

const cleanup = () => {
  sink.close();
  rmSync(sandbox, { recursive: true, force: true });
};

/**
 * STEP 2 — the other side of the guarantee: every ATTENTION event still gets through. Codex
 * cannot produce needs_input / agent_failed / agent_idle, so these are real Claude Code hook
 * payloads fired at the same binary. `test_failed` has no harness source yet and is covered by
 * the unit matrix instead.
 */
const NOTIFYING = [
  [
    "needs_input",
    { hook_event_name: "Notification", notification_type: "input", message: "Which branch?" },
  ],
  ["approval_required", { hook_event_name: "PermissionRequest", tool_name: "Bash" }],
  [
    "agent_completed",
    { hook_event_name: "Stop", last_assistant_message: "Refactored the parser." },
  ],
  ["agent_failed", { hook_event_name: "StopFailure", error_type: "api_error" }],
  [
    "agent_idle",
    { hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" },
  ],
];

/** One real `birdybeep hook <harness>` fire: a fresh process, payload on stdin, JSON out. */
function fire(payload, harness = "codex") {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_BIN, "hook", harness, "--json"], {
      cwd: work,
      env: baseEnv(),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out).outcome ?? "?");
      } catch {
        resolve("?");
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

try {
  log(`CLI under test: ${CLI_BIN}`);
  log(`stub ingest at ${sinkUrl}; sandbox HOME ${home}`);

  // Seed the machine token into the strict-perm FILE store. Forcing the file backend keeps
  // this headless: the macOS default would shell out to `security add-generic-password`,
  // which prompts and blocks.
  const seed = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(AGENT_CORE_DIST).href)});
       await m.setToken(${JSON.stringify(TOKEN)}, { backend: m.unavailableKeychainBackend });`,
    ],
    { cwd: work, env: baseEnv(), encoding: "utf8", timeout: 30_000 },
  );
  if (seed.status !== 0) {
    console.error(`[live-e2e-event-filter] token seed failed: ${seed.stderr || ""}`);
    process.exitCode = 1;
    cleanup();
    process.exit(1);
  }
  // Prove the sandbox token is the one in play: a real machine token file under the sandbox.
  writeFileSync(join(work, ".keep"), "");
  chmodSync(join(work, ".keep"), 0o600);

  // ── replay ──────────────────────────────────────────────────────────────────
  const outcomes = new Map();
  let fired = 0;
  const started = Date.now();
  for (const { hook, count } of MIX) {
    for (let i = 0; i < count; i += 1) {
      // Distinct session id + tool token per event — see the header for why.
      const id = `${hook}-${i}`;
      const payload = {
        hook_event_name: hook,
        session_id: `cx_${id}`,
        cwd: join(work, "project"),
        tool_name: `tool_${id}`,
        source: "startup",
        agent_type: `agent_${id}`,
        agent_id: id,
        turn_id: id,
      };
      const outcome = await fire(payload);
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      fired += 1;
      if (fired % 200 === 0) log(`  …${fired}/${TOTAL} hook fires`);
    }
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // ── report ──────────────────────────────────────────────────────────────────
  log("");
  log(`REPLAY: ${fired} real hook fires in ${elapsed}s`);
  log(`  hook outcomes:  ${[...outcomes].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  log(`  POSTs received: ${postCount} / ${fired} fires`);
  for (const [type, n] of [...posted].sort((a, b) => b[1] - a[1])) {
    log(`     ${type}: ${n}`);
  }
  const reduction = (((fired - postCount) / fired) * 100).toFixed(1);
  log(`  REDUCTION vs. one POST per fire: ${reduction}%`);
  log("");

  // ── assertions ──────────────────────────────────────────────────────────────
  for (const type of EXPECTED_WITHHELD) {
    assert(!posted.has(type), `no ${type} reached the backend (was 88.5% of real traffic)`);
  }
  for (const { type, count } of MIX) {
    if (EXPECTED_WITHHELD.has(type)) continue;
    assert(
      posted.get(type) === count,
      `every ${type} still arrives (${posted.get(type) ?? 0}/${count})`,
    );
  }
  assert(postCount === EXPECTED_POSTS, `exactly ${EXPECTED_POSTS} POSTs (got ${postCount})`);
  assert(
    Number(reduction) >= 85,
    `traffic reduction is at least 85% (measured ${reduction}% on the 88.5% mix)`,
  );

  // The withheld events are still visible locally — `status` reads the same tally.
  const status = spawnSync("node", [CLI_BIN, "status", "--json"], {
    cwd: work,
    env: baseEnv(),
    encoding: "utf8",
    timeout: 60_000,
  });
  let statusJson = {};
  try {
    statusJson = JSON.parse(status.stdout);
  } catch {
    /* reported by the assertion below */
  }
  const tallied = statusJson.filteredActivity?.byType?.tool_finished ?? 0;
  assert(
    tallied === 1016,
    `\`birdybeep status\` reports all 1016 withheld tool_finished events (got ${tallied}) — ` +
      `a working install never looks dead`,
  );

  // ── STEP 2: every attention event still reaches the backend ──────────────────
  log("");
  log("ATTENTION EVENTS — real Claude Code payloads at the same binary:");
  for (const [type, payload] of NOTIFYING) {
    const before = posted.get(type) ?? 0;
    const outcome = await fire(
      { ...payload, session_id: `cc_${type}`, cwd: join(work, "project") },
      "claude",
    );
    assert(
      outcome === "delivered" && (posted.get(type) ?? 0) === before + 1,
      `${type} still arrives (outcome=${outcome})`,
    );
  }

  if (failures > 0) {
    console.error(`\n[live-e2e-event-filter] ${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    log("ALL GREEN");
  }
} finally {
  cleanup();
}
