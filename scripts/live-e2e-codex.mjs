#!/usr/bin/env node
/**
 * LIVE end-to-end verification for the Codex adapter (§ CLAUDE.md "real end-to-end
 * testing"). Unlike the vitest E2E (packages/codex/src/e2e.test.ts), which fires
 * captured payloads through the pipeline in-process, this script drives the REAL
 * `codex` binary end to end:
 *
 *   1. hermetic sandbox HOME (never touches the real machine)
 *   2. `birdybeep agent install codex` writes the managed config
 *   3. machine token seeded into the strict-perm FILE store (no keychain in CI)
 *   4. hook trust granted through Codex's own "Hooks need review" TUI dialog,
 *      driven over a pty — the same flow a human uses; nothing is forged
 *   5. a real `codex exec` session runs against a cheap OpenRouter model, firing
 *      real SessionStart / PostToolUse hooks + the notify program, each of which
 *      spawns the real `birdybeep hook codex` CLI
 *   6. events must arrive at a local stub ingest server: correct types, Bearer
 *      token, hashed cwd, and NO raw user/assistant/tool content
 *   7. status transitions needs_trust → installed are asserted along the way
 *   8. uninstall restores the config (user keys preserved, managed entries gone)
 *
 * Requirements (checked up front; the script SKIPS with exit 2 when unmet so it
 * can sit in an optional CI lane):
 *   - `codex` on PATH (tested against codex-cli 0.144.x)
 *   - OPENROUTER_API_KEY or BIRDYBEEP_OPENROUTER_API_KEY env var
 *   - python3 (pty driver for the trust dialog) — POSIX only
 *   - repo built (`pnpm build`)
 *
 * Run:  node scripts/live-e2e-codex.mjs
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
const TUI_DRIVER = join(REPO, "scripts", "lib", "tui-drive.py");
const MODEL = process.env.BIRDYBEEP_E2E_MODEL ?? "openai/gpt-oss-120b";
const TOKEN = "bbm_live_e2e_codex_token";
const OPENROUTER_KEY =
  process.env.OPENROUTER_API_KEY ?? process.env.BIRDYBEEP_OPENROUTER_API_KEY ?? "";

// ── tiny assertion + logging helpers ─────────────────────────────────────────
let step = 0;
const log = (msg) => console.log(`[live-e2e-codex] ${msg}`);
const begin = (msg) => log(`step ${++step}: ${msg}`);
function fail(msg) {
  console.error(`[live-e2e-codex] FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function skip(msg) {
  console.error(`[live-e2e-codex] SKIP: ${msg}`);
  process.exit(2);
}

// ── preconditions ────────────────────────────────────────────────────────────
if (process.platform === "win32") skip("pty trust driver is POSIX-only");
if (!existsSync(CLI_BIN)) skip(`CLI not built (${CLI_BIN}); run pnpm build`);
if (OPENROUTER_KEY === "") skip("OPENROUTER_API_KEY / BIRDYBEEP_OPENROUTER_API_KEY not set");
const codexVersion = spawnSync("codex", ["--version"], { encoding: "utf8" });
if (codexVersion.status !== 0) skip("codex binary not on PATH");
const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
if (python.status !== 0) skip("python3 not available for the pty trust driver");
log(`codex: ${codexVersion.stdout.trim()}`);

// ── sandbox layout ───────────────────────────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-live-codex-"));
const home = join(sandbox, "home");
const work = join(sandbox, "work");
const bin = join(sandbox, "bin");
const codexHome = join(home, ".codex");
for (const d of [home, work, bin, codexHome]) mkdirSync(d, { recursive: true });
// The managed config invokes the bare `birdybeep` command; the sandbox provides
// it as a wrapper around the freshly built CLI, exactly like a global install.
// With BIRDYBEEP_E2E_KEEP set the wrapper additionally tees each hook fire's
// outcome to fires.log for post-mortem diagnostics.
const wrapper = process.env.BIRDYBEEP_E2E_KEEP
  ? `#!/bin/sh
if [ "$1" = hook ]; then
  P="$3"; [ -z "$P" ] && P=$(cat)
  EV=$(printf '%s' "$P" | grep -oE '"hook_event_name":"[^"]*"|agent-turn-complete' | head -1)
  OUT=$(printf '%s' "$P" | node "${CLI_BIN}" "$@" --json 2>/dev/null)
  printf '%s -> %s\\n' "$EV" "$OUT" >> "${sandbox}/fires.log"
else
  exec node "${CLI_BIN}" "$@"
fi
`
  : `#!/bin/sh\nexec node "${CLI_BIN}" "$@"\n`;
writeFileSync(join(bin, "birdybeep"), wrapper);
chmodSync(join(bin, "birdybeep"), 0o755);

// sinkUrl is created just below; baseEnv points EVERY codex/birdybeep invocation
// at it (via BIRDYBEEP_API_URL) so no fire ever queues against the unreachable
// default api.birdybeep.com and then drains into a later step's assertions.
let sinkUrl = "";
const makeBaseEnv = () => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  CODEX_HOME: codexHome,
  PATH: `${bin}:${process.env.PATH}`,
  OPENROUTER_API_KEY: OPENROUTER_KEY,
  BIRDYBEEP_API_URL: sinkUrl,
});

function run(cmd, args, { env = {}, input, timeoutMs = 120_000 } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: work,
    env: { ...makeBaseEnv(), ...env },
    encoding: "utf8",
    input: input ?? "",
    timeout: timeoutMs,
  });
  return res;
}
/**
 * Async variant of {@link run} — critical for any command that fires hooks while
 * the in-process stub sink must stay responsive. `spawnSync` blocks the Node event
 * loop for the child's whole lifetime, so the in-process HTTP sink cannot answer a
 * hook's POST until the child exits; the hook then hits its send timeout, queues
 * the (physically-delivered) event, and later drains re-deliver it — a pure test
 * artifact (a real out-of-process backend answers immediately). Awaiting an async
 * spawn keeps the loop free so the sink responds in-band.
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
function birdybeep(args, env = {}) {
  return run("node", [CLI_BIN, ...args, "--json"], { env });
}
/** Parse `birdybeep status --json` and return the codex integration status string. */
function codexStatusValue(env = {}) {
  const res = birdybeep(["status"], env);
  assert(res.status === 0, `status failed: ${res.stderr} ${res.stdout}`);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    fail(`status did not emit JSON: ${res.stdout}`);
  }
  const codex = (parsed.integrations ?? []).find((i) => i.harness === "codex");
  assert(codex, `no codex integration in status output: ${res.stdout}`);
  return codex.status;
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
      /* keep raw string */
    }
    received.push({ path: req.url, headers: req.headers, body });
    if (process.env.BIRDYBEEP_E2E_KEEP && typeof body === "object") {
      log(
        `  ↳ sink recv: ${body.event_type} session=${String(body.source_session_id).slice(0, 20)} ` +
          `status=${body.status}`,
      );
    }
    res.statusCode = 202;
    res.end(JSON.stringify({ accepted: true }));
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
  const configPath = join(codexHome, "config.toml");

  // ── 1. user-side model config FIRST (real order: configure codex, then add
  //       BirdyBeep). Bare scalars must precede any [table]/[[array]] header, or
  //       TOML scopes `model_provider` INTO the last hooks table — which makes
  //       Codex ignore OpenRouter and 401 against api.openai.com. Writing the
  //       user config before install (which parses → merges → re-stringifies)
  //       keeps the scalars top-level. ──────────────────────────────────────────
  begin("write user Codex config (OpenRouter, cheap model) before install");
  const userConfig = `model_provider = "openrouter"
model = "${MODEL}"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"

[projects."${work}"]
trust_level = "trusted"
`;
  writeFileSync(configPath, userConfig);

  // ── 2. seed the machine token into the FILE store under the sandbox HOME ──
  begin("seed machine token (file store fallback)");
  const seed = run("node", [
    "--input-type=module",
    "-e",
    `const { setToken } = await import(${JSON.stringify(pathToFileURL(AGENT_CORE_DIST).href)});
     const kind = await setToken(${JSON.stringify(TOKEN)});
     console.log("token store:", kind);`,
  ]);
  assert(seed.status === 0, `token seed failed: ${seed.stderr}`);
  log(seed.stdout.trim());

  // ── 3. install the adapter (merges hooks, backs up the user config) ───────
  begin("birdybeep agent install codex");
  const install = birdybeep(["agent", "install", "codex"]);
  assert(install.status === 0, `install failed: ${install.stderr} ${install.stdout}`);
  assert(existsSync(configPath), "install did not create config.toml");
  const installedConfig = readFileSync(configPath, "utf8");
  assert(installedConfig.includes("birdybeep hook codex"), "managed hook command missing");
  assert(!installedConfig.includes(TOKEN), "token leaked into harness config");
  assert(
    installedConfig.includes('model_provider = "openrouter"'),
    "install dropped user model_provider",
  );
  // The user config was backed up before modification.
  assert(existsSync(`${configPath}.birdybeep-backup`), "install did not back up the user config");

  // idempotency: a second install is a no-op
  const reinstall = birdybeep(["agent", "install", "codex"]);
  assert(reinstall.status === 0, "re-install failed");
  assert(
    readFileSync(configPath, "utf8") === installedConfig,
    "double install changed the config (not idempotent)",
  );

  begin("status is needs_trust before any trusted hook fires");
  assert(
    codexStatusValue() === "needs_trust",
    "expected codex status needs_trust right after install",
  );

  // ── 4. trust the hooks through Codex's own review dialog ──────────────────
  // With a valid custom model_provider configured, Codex skips the ChatGPT
  // welcome and opens the "Hooks need review" dialog: option 1 = Review, 2 =
  // Trust all and continue, 3 = Continue without trusting. One DOWN selects
  // "Trust all", ENTER confirms.
  begin("trust hooks via the real /hooks review dialog (pty)");
  const trust = run("python3", [TUI_DRIVER, join(sandbox, "tui.log"), work, "codex"], {
    env: {
      TUI_SCRIPT: "14:DOWN\n2:ENTER\n5:SPACE",
    },
    timeoutMs: 90_000,
  });
  assert(trust.status === 0, `tui driver failed: ${trust.stderr}`);
  const trusted = readFileSync(configPath, "utf8");
  assert(
    trusted.includes("[hooks.state") && trusted.includes("trusted_hash"),
    "no [hooks.state]/trusted_hash entries were written — the trust dialog was not completed " +
      `(see ${join(sandbox, "tui.log")})`,
  );
  log("hooks trusted (trusted_hash entries present)");

  assert(
    codexStatusValue() === "needs_trust",
    "status must stay needs_trust until a trust-gated hook event actually fires",
  );

  // ── 5. real codex exec session ─────────────────────────────────────────────
  // Clear anything queued/delivered by earlier steps so this step's assertions
  // see ONLY the exec's own fires (the offline queue drains opportunistically on
  // every send, which would otherwise mix earlier events into these counts).
  begin("reset queue + captured events before the measured exec");
  birdybeep(["queue", "clear"]);
  received.length = 0;

  begin(`real codex exec session against ${MODEL}`);
  // Async spawn (NOT spawnSync) so the in-process sink stays responsive while the
  // session's hooks fire — see runAsync's note. The prompt is emphatic so the cheap
  // model reliably makes a real shell tool call (→ PostToolUse → tool_finished).
  const exec = await runAsync(
    "codex",
    [
      "exec",
      "--skip-git-repo-check",
      "You MUST use your shell/exec tool to run exactly this command: echo hello. " +
        "Do not answer from memory — actually call the tool, then report the output.",
    ],
    { timeoutMs: 180_000 },
  );
  assert(exec.status === 0, `codex exec failed (${exec.status}): ${exec.stderr.slice(-800)}`);

  begin("await event delivery to the stub sink");
  const deadline = Date.now() + 30_000;
  const wantTypes = ["session_started", "tool_finished", "agent_completed"];
  const haveAll = () => {
    const t = new Set(received.map((r) => r.body?.event_type));
    return wantTypes.every((w) => t.has(w));
  };
  while (Date.now() < deadline && !haveAll()) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const events = received.filter((r) => r.path === "/v1/agent-events");
  const types = events.map((e) => e.body?.event_type);
  log(`delivered event types: ${JSON.stringify(types)}`);

  // ── 6. assertions on the delivered events ─────────────────────────────────
  // Assert the SET of mapped types, not exact counts: the real model's tool-use
  // count varies run to run, so exact counts are not a stable invariant.
  assert(
    types.includes("session_started"),
    "session_started was not delivered (SessionStart hook)",
  );
  assert(types.includes("tool_finished"), "tool_finished was not delivered (PostToolUse hook)");
  assert(types.includes("agent_completed"), "agent_completed was not delivered (notify program)");
  // Every codex exec fires exactly one SessionStart — with the queue cleared and
  // all runs pointed at the sink, session_started must not be duplicated.
  const sessionStarts = types.filter((t) => t === "session_started").length;
  assert(
    sessionStarts === 1,
    `expected exactly one session_started for one exec, got ${sessionStarts} — dedup/queue regression`,
  );
  const sessionIds = new Set(events.map((e) => e.body?.source_session_id));
  assert(sessionIds.size === 1, `events span ${sessionIds.size} sessions; expected 1`);

  for (const e of events) {
    assert(
      e.headers.authorization === `Bearer ${TOKEN}`,
      `event not authed with the seeded token: ${e.headers.authorization}`,
    );
    assert(e.body.harness === "codex", `wrong harness on event: ${e.body.harness}`);
    assert(
      typeof e.body.workspace?.cwd === "string" && e.body.workspace.cwd.startsWith("h_"),
      `workspace.cwd not hashed: ${e.body.workspace?.cwd}`,
    );
  }
  // Inspect the event BODIES only — the Bearer token correctly rides the
  // Authorization HEADER (asserted above), so it must be excluded here.
  const bodies = JSON.stringify(events.map((e) => e.body));
  assert(!bodies.includes("echo hello"), "raw tool input leaked into a delivered event body");
  assert(!bodies.includes(sandbox), "raw sandbox path leaked into a delivered event body");
  assert(!bodies.includes(TOKEN), "machine token leaked into an event body");
  assert(!bodies.includes(OPENROUTER_KEY), "OpenRouter API key leaked into a delivered event body");

  // ── 7. trust-gated event flips status to installed ────────────────────────
  begin("status flips to installed after a trust-gated hook delivered");
  assert(
    codexStatusValue() === "installed",
    "expected codex status installed after a trusted lifecycle hook delivered",
  );

  // ── 8. uninstall restores the config ───────────────────────────────────────
  begin("uninstall removes managed entries, preserves user config");
  const uninstall = birdybeep(["agent", "uninstall", "codex"]);
  assert(uninstall.status === 0, `uninstall failed: ${uninstall.stderr}`);
  const after = readFileSync(configPath, "utf8");
  // NB: the sandbox path literally contains "birdybeep", so assert on the actual
  // managed CONTENT, not the substring "birdybeep".
  assert(!after.includes("birdybeep hook codex"), "managed hook command survived uninstall");
  assert(!/notify\s*=/.test(after), "managed notify survived uninstall");
  assert(
    !/\[\[hooks\.(SessionStart|PermissionRequest|PostToolUse|SubagentStart|SubagentStop)\]\]/.test(
      after,
    ),
    "a managed [[hooks.X]] table survived uninstall",
  );
  assert(after.includes(`model = "${MODEL}"`), "user model config lost on uninstall");
  assert(after.includes("model_providers.openrouter"), "user model_providers lost on uninstall");

  log("");
  log(`PASS — ${events.length} events delivered end-to-end through the real codex binary`);
  log(`       (${JSON.stringify(types)})`);
} finally {
  cleanup();
}
