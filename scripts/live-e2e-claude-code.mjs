#!/usr/bin/env node
/**
 * LIVE end-to-end verification for the Claude Code adapter (§ CLAUDE.md "real
 * end-to-end testing"). Drives the REAL `claude` binary end to end:
 *
 *   1. hermetic sandbox HOME (never touches the real machine)
 *   2. `birdybeep agent install claude` patches ~/.claude/settings.json
 *   3. machine token seeded into the strict-perm FILE store (no keychain in CI)
 *   4. a real `claude -p` session against a cheap model via OpenRouter's
 *      Anthropic-compatible endpoint, firing real SessionStart / Stop / SessionEnd
 *      hooks, each spawning the real `birdybeep hook claude` CLI
 *   5. events must arrive at a local stub sink with the right types, Bearer token,
 *      hashed cwd, and NO raw prompt/response content
 *   6. uninstall restores settings.json (user hooks preserved, managed entries gone)
 *
 * Claude Code (unlike Codex) has NO trust gate — hooks fire the moment they are in
 * settings.json — so status goes straight to `installed` and there is no TUI to drive.
 *
 * Requirements (SKIP with exit 2 when unmet):
 *   - `claude` on PATH
 *   - OPENROUTER_API_KEY or BIRDYBEEP_OPENROUTER_API_KEY env var
 *     (routed through OpenRouter's Anthropic "skin": ANTHROPIC_BASE_URL + AUTH_TOKEN)
 *   - repo built (`pnpm build`)
 *
 * Run:  node scripts/live-e2e-claude-code.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_BIN = join(REPO, "packages", "cli", "dist", "bin.js");
const AGENT_CORE_DIST = join(REPO, "packages", "agent-core", "dist", "index.js");
const MODEL = process.env.BIRDYBEEP_E2E_MODEL ?? "openai/gpt-oss-120b";
const TOKEN = "bbm_live_e2e_claude_token";
const OPENROUTER_KEY =
  process.env.OPENROUTER_API_KEY ?? process.env.BIRDYBEEP_OPENROUTER_API_KEY ?? "";

let step = 0;
const log = (msg) => console.log(`[live-e2e-claude] ${msg}`);
const begin = (msg) => log(`step ${++step}: ${msg}`);
function fail(msg) {
  console.error(`[live-e2e-claude] FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function skip(msg) {
  console.error(`[live-e2e-claude] SKIP: ${msg}`);
  process.exit(2);
}

// ── preconditions ────────────────────────────────────────────────────────────
if (!existsSync(CLI_BIN)) skip(`CLI not built (${CLI_BIN}); run pnpm build`);
if (OPENROUTER_KEY === "") skip("OPENROUTER_API_KEY / BIRDYBEEP_OPENROUTER_API_KEY not set");
const claudeVersion = spawnSync("claude", ["--version"], { encoding: "utf8" });
if (claudeVersion.status !== 0) skip("claude binary not on PATH");
log(`claude: ${claudeVersion.stdout.trim()}`);

// ── sandbox layout ───────────────────────────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-live-claude-"));
const home = join(sandbox, "home");
const work = join(sandbox, "work");
const bin = join(sandbox, "bin");
for (const d of [home, work, bin, join(home, ".claude")]) mkdirSync(d, { recursive: true });
writeFileSync(join(bin, "birdybeep"), `#!/bin/sh\nexec node "${CLI_BIN}" "$@"\n`);
chmodSync(join(bin, "birdybeep"), 0o755);

let sinkUrl = "";
// Env for `birdybeep` CLI calls — inherits the parent env, just re-homed.
const makeBaseEnv = () => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  PATH: `${bin}:${process.env.PATH}`,
  BIRDYBEEP_API_URL: sinkUrl,
});
// Env for the real `claude` run — a CLEAN slate (no inherited CLAUDE_*/ANTHROPIC_*
// from a parent Claude Code session, which would hijack model/auth resolution),
// pointed at OpenRouter's Anthropic-compatible endpoint.
const makeClaudeEnv = () => ({
  PATH: `${bin}:${process.env.PATH}`,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  BIRDYBEEP_API_URL: sinkUrl,
  ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
  ANTHROPIC_AUTH_TOKEN: OPENROUTER_KEY,
  ANTHROPIC_MODEL: MODEL,
  ANTHROPIC_SMALL_FAST_MODEL: MODEL,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});

function birdybeep(args) {
  return spawnSync("node", [CLI_BIN, ...args, "--json"], {
    cwd: work,
    env: makeBaseEnv(),
    encoding: "utf8",
  });
}
function claudeStatusValue() {
  const res = birdybeep(["status"]);
  assert(res.status === 0, `status failed: ${res.stderr} ${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  const cc = (parsed.integrations ?? []).find((i) => i.harness === "claude_code");
  assert(cc, `no claude_code integration in status: ${res.stdout}`);
  return cc.status;
}
/** Async spawn so the in-process sink stays responsive while claude's hooks fire. */
async function runClaude(prompt) {
  const child = spawn("claude", ["-p", prompt, "--output-format", "text"], {
    cwd: work,
    env: makeClaudeEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
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
  const settingsPath = join(home, ".claude", "settings.json");

  // ── 1. pre-existing user settings (proves non-destructive patching) ───────
  begin("write pre-existing user settings.json");
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ model: "sonnet", hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo user-hook", timeout: 5 }] }] } }, null, 2)}\n`,
  );
  const originalSettings = readFileSync(settingsPath, "utf8");

  // ── 2. seed token ─────────────────────────────────────────────────────────
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

  // ── 3. install ────────────────────────────────────────────────────────────
  begin("birdybeep agent install claude");
  const install = birdybeep(["agent", "install", "claude"]);
  assert(install.status === 0, `install failed: ${install.stderr} ${install.stdout}`);
  const installed = readFileSync(settingsPath, "utf8");
  assert(installed.includes("birdybeep hook claude"), "managed hook command missing");
  assert(
    installed.includes("echo user-hook"),
    "install clobbered the user's own SessionStart hook",
  );
  assert(!installed.includes(TOKEN), "token leaked into settings.json");
  assert(existsSync(`${settingsPath}.birdybeep-backup`), "install did not back up user settings");

  // idempotency
  const reinstall = birdybeep(["agent", "install", "claude"]);
  assert(reinstall.status === 0, "re-install failed");
  assert(readFileSync(settingsPath, "utf8") === installed, "double install not idempotent");

  // Claude Code has no trust/restart gate → installed immediately.
  begin("status is installed (no gate)");
  assert(
    claudeStatusValue() === "installed",
    "expected claude_code status installed after install",
  );

  // ── 4. real claude -p session ──────────────────────────────────────────────
  begin(`real claude -p session against ${MODEL} via OpenRouter`);
  received.length = 0;
  const run = await runClaude("Reply with exactly one word: pong");
  assert(run.status === 0, `claude run failed (${run.status}): ${run.stderr.slice(-500)}`);

  // ── 5. await delivery ──────────────────────────────────────────────────────
  begin("await event delivery to the stub sink");
  const want = ["session_started", "agent_completed"];
  const deadline = Date.now() + 20_000;
  const have = () => new Set(received.map((r) => r.body?.event_type));
  while (Date.now() < deadline && !want.every((w) => have().has(w))) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const events = received.filter((r) => r.path === "/v1/agent-events");
  const types = events.map((e) => e.body?.event_type);
  log(`delivered event types: ${JSON.stringify(types)}`);

  // ── 6. assertions ──────────────────────────────────────────────────────────
  assert(types.includes("session_started"), "session_started not delivered (SessionStart hook)");
  assert(types.includes("agent_completed"), "agent_completed not delivered (Stop hook)");
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
  const bodies = JSON.stringify(events.map((e) => e.body));
  assert(!bodies.includes("pong"), "raw model response leaked into a delivered event body");
  assert(!bodies.includes(sandbox), "raw sandbox path leaked into a delivered event body");
  assert(!bodies.includes(TOKEN), "machine token leaked into an event body");
  assert(!bodies.includes(OPENROUTER_KEY), "OpenRouter key leaked into an event body");

  // ── 7. uninstall restores the user's original settings ────────────────────
  begin("uninstall removes managed entries, preserves the user hook");
  const uninstall = birdybeep(["agent", "uninstall", "claude"]);
  assert(uninstall.status === 0, `uninstall failed: ${uninstall.stderr}`);
  const after = readFileSync(settingsPath, "utf8");
  assert(!after.includes("birdybeep hook claude"), "managed hook survived uninstall");
  assert(after.includes("echo user-hook"), "user's own hook lost on uninstall");
  // Untouched-since-install → restored byte-for-byte to the pre-install file.
  assert(
    after === originalSettings,
    "settings not restored byte-for-byte to the pre-install original",
  );

  log("");
  log(
    `PASS — real claude ${claudeVersion.stdout.trim()} delivered ${events.length} events: ${JSON.stringify(types)}`,
  );
} finally {
  cleanup();
}
