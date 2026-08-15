#!/usr/bin/env node
/**
 * LIVE end-to-end verification for Cursor's Claude Code compatibility bridge
 * (birdybeep-agent-gcgp.1). Cursor desktop reads `~/.claude/settings.json` and runs the
 * commands it finds there with its OWN payload — so with BirdyBeep's Claude hooks installed
 * it executes `birdybeep hook claude` and feeds it a CURSOR payload. Every one of those fires
 * used to exit 0 and deliver nothing.
 *
 * This drives the REAL CLI binary, the way Cursor does:
 *
 *   1. hermetic sandbox HOME (never touches the real machine); PATH deliberately excludes
 *      macOS `security`, so the token comes from the strict-perm FILE store
 *   2. the adapter is installed the REAL way — `birdybeep agent install claude` writes
 *      ~/.claude/settings.json with `birdybeep hook claude` entries (this is the file Cursor
 *      reads); we assert the managed entries landed
 *   3. the two payloads captured VERBATIM from Cursor 3.14.27's own hook log are piped into
 *      the real `birdybeep hook claude` on stdin, exactly as the bridge does
 *   4. each must exit 0, report `harness: "cursor"` + `routedFrom: "claude"`, and DELIVER a
 *      correctly-normalized event to the stub sink — with Cursor's privacy invariants intact
 *      (cwd hashed, no user_email, no transcript_path)
 *   5. a payload no adapter recognizes must fail LOUDLY: non-zero exit + a stderr line, never
 *      the silent exit 0 that hid this bug for months
 *
 * Requirements (SKIP with exit 2 when unmet): repo built (`pnpm build`). No Cursor install and
 * no network needed — the bridge's behavior is fully captured by the payloads it sends.
 *
 * Run:  node scripts/live-e2e-cursor-claude-bridge.mjs
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
const FIXTURES = join(REPO, "packages", "cursor", "src", "__fixtures__");
const TOKEN = "bbm_live_e2e_bridge_token";

const log = (msg) => console.log(`[live-e2e-bridge] ${msg}`);
const fail = (msg) => {
  console.error(`[live-e2e-bridge] FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};
const skip = (msg) => {
  console.error(`[live-e2e-bridge] SKIP: ${msg}`);
  process.exit(2);
};
const assert = (cond, msg) => {
  if (!cond) fail(msg);
};
const begin = (msg) => log(`▶ ${msg}`);

if (!existsSync(CLI_BIN)) skip(`CLI not built (${CLI_BIN}) — run pnpm build`);

const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-live-bridge-"));
const home = join(sandbox, "home");
const work = join(sandbox, "work");
const bin = join(sandbox, "bin");
for (const d of [home, work, bin]) mkdirSync(d, { recursive: true });
// ~/.claude is the precondition for this whole failure mode: it is what Claude Code detection
// keys on AND the config Cursor's bridge reads. Create it so detection never depends on
// whether a `claude` binary happens to sit on the outer PATH.
mkdirSync(join(home, ".claude"), { recursive: true });
// A real-looking checkout so repo/branch detection has something to find.
mkdirSync(join(work, ".git"), { recursive: true });
writeFileSync(join(work, ".git", "HEAD"), "ref: refs/heads/main\n");
// birdybeep on PATH — the settings.json command is the bare name `birdybeep hook claude`.
writeFileSync(join(bin, "birdybeep"), `#!/bin/sh\nexec node "${CLI_BIN}" "$@"\n`);
chmodSync(join(bin, "birdybeep"), 0o755);

/** The captured Cursor payloads, re-rooted at the sandbox checkout. */
function fixture(name) {
  const payload = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  payload.workspace_roots = [work];
  return payload;
}
const BRIDGE_SESSION_START = fixture("bridge-claude-sessionStart.json");
const BRIDGE_STOP = fixture("bridge-claude-stop.json");
const RAW_EMAIL = BRIDGE_SESSION_START.user_email;
const RAW_TRANSCRIPT = BRIDGE_STOP.transcript_path;

let sinkUrl = "";
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

// PATH holds ONLY the sandbox bin + Node's own dir: no macOS `security`, so a token can never
// come from (or land in) the real login keychain — the strict-perm file store is the only path.
const makeBaseEnv = () => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  PATH: `${bin}:${dirname(process.execPath)}`,
  BIRDYBEEP_API_URL: sinkUrl,
});

/**
 * Fire the hook exactly as Cursor does: the real CLI, payload on stdin. Async spawn (not
 * spawnSync) so this process's event loop stays free — the stub sink runs in-process and has
 * to answer the hook's POST, which a blocking spawn would deadlock into a `queued` outcome.
 */
async function hookClaude(payload) {
  const child = spawn("node", [CLI_BIN, "hook", "claude", "--json"], {
    cwd: work,
    env: makeBaseEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(JSON.stringify(payload));
  const [status] = await once(child, "close");
  return { status, stdout, stderr };
}

const cleanup = () => {
  sink.close();
  if (process.env.BIRDYBEEP_E2E_KEEP) {
    log(`BIRDYBEEP_E2E_KEEP set — leaving sandbox at ${sandbox}`);
    return;
  }
  rmSync(sandbox, { recursive: true, force: true });
};

try {
  // ── 1. seed the machine token into the FILE store ─────────────────────────
  begin("seed machine token (file store fallback)");
  const seed = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      // The FILE store explicitly: the sandbox PATH has no `security`, and the real login
      // keychain is the user's, not the sandbox's — it must never be read or written here.
      `const { setToken, unavailableKeychainBackend } = await import(${JSON.stringify(pathToFileURL(AGENT_CORE_DIST).href)});
       console.log("token store:", await setToken(${JSON.stringify(TOKEN)}, { backend: unavailableKeychainBackend }));`,
    ],
    { env: makeBaseEnv(), encoding: "utf8" },
  );
  assert(seed.status === 0, `token seed failed: ${seed.stderr}`);
  log(seed.stdout.trim());

  // ── 2. REAL install: the very file Cursor's bridge reads ──────────────────
  begin("birdybeep agent install claude (writes the settings.json Cursor reads)");
  const inst = spawnSync("node", [CLI_BIN, "agent", "install", "claude", "--json"], {
    cwd: work,
    env: makeBaseEnv(),
    encoding: "utf8",
  });
  assert(inst.status === 0, `install failed: ${inst.stderr || inst.stdout}`);
  log(`install: ${inst.stdout.trim()}`);
  const settingsPath = join(home, ".claude", "settings.json");
  assert(existsSync(settingsPath), `settings.json not written at ${settingsPath}`);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const commands = Object.values(settings.hooks ?? {}).flatMap((entries) =>
    (Array.isArray(entries) ? entries : []).flatMap((e) => (e?.hooks ?? []).map((h) => h?.command)),
  );
  assert(
    commands.includes("birdybeep hook claude"),
    "settings.json has no `birdybeep hook claude` entry",
  );
  log(`settings.json events: ${Object.keys(settings.hooks ?? {}).join(", ")}`);

  // ── 3-4. the bridge's own payloads → real hook → delivered as cursor ──────
  const expected = [
    ["sessionStart", BRIDGE_SESSION_START, "session_started"],
    ["stop", BRIDGE_STOP, "agent_completed"],
  ];
  for (const [name, payload, eventType] of expected) {
    begin(`bridged ${name} → birdybeep hook claude (real CLI, stdin)`);
    const run = await hookClaude(payload);
    log(`exit=${run.status} stdout=${run.stdout.trim()} stderr=${run.stderr.trim() || "(empty)"}`);
    assert(run.status === 0, `bridged ${name} exited ${run.status} (expected 0)`);
    const out = JSON.parse(run.stdout.trim());
    assert(
      out.harness === "cursor" && out.routedFrom === "claude",
      `bridged ${name} not routed to cursor: ${run.stdout.trim()}`,
    );
    assert(
      out.outcome === "delivered",
      `bridged ${name} outcome ${out.outcome} (expected delivered) — this is the gcgp.1 drop`,
    );
    assert(out.eventType === eventType, `bridged ${name} → ${out.eventType} (want ${eventType})`);
  }

  begin("assert delivery + Bearer + hashed cwd + NO PII at the sink");
  assert(received.length === 2, `sink got ${received.length} event(s), expected 2`);
  for (const r of received) {
    assert(r.path === "/v1/agent-events", `unexpected sink path ${r.path}`);
    assert(
      r.headers.authorization === `Bearer ${TOKEN}`,
      `missing/incorrect Bearer on ${r.body?.event_type}`,
    );
    assert(r.body.harness === "cursor", `harness ${r.body.harness} (expected cursor)`);
    const wire = JSON.stringify(r.body);
    assert(!wire.includes(RAW_EMAIL), `user_email leaked in ${r.body.event_type}`);
    assert(!wire.includes(RAW_TRANSCRIPT), `transcript_path leaked in ${r.body.event_type}`);
    assert(!wire.includes(work), `raw workspace path leaked in ${r.body.event_type}`);
    assert(
      /^h_[0-9a-f]{16}$/.test(r.body.workspace?.cwd ?? ""),
      `cwd not hashed in ${r.body.event_type}: ${r.body.workspace?.cwd}`,
    );
  }
  log(`delivered: ${received.map((r) => r.body.event_type).join(", ")}`);

  // ── 5. an unrecognized payload must be LOUD, never a silent exit 0 ────────
  begin("unrecognized payload → loud, non-zero, human-readable (never silent exit 0)");
  const before = received.length;
  const bogus = await hookClaude({ hook_event_name: "someFutureStep", session_id: "s", cwd: work });
  log(`exit=${bogus.status} stderr=${bogus.stderr.trim() || "(empty)"}`);
  assert(bogus.status !== 0, "unrecognized payload exited 0 — the gcgp.1 silence is back");
  assert(bogus.stderr.includes("someFutureStep"), "stderr does not name the offending event");
  assert(bogus.stderr.includes("nothing was sent"), "stderr does not say nothing was sent");
  assert(received.length === before, "an unrecognized payload must not deliver anything");

  // ── 6. the loudness must not become noise ─────────────────────────────────
  // The bridge fires beforeSubmitPrompt (from Claude's UserPromptSubmit) on EVERY prompt and we
  // deliberately don't map it. That has to stay a silent, zero-exit skip, or every prompt would
  // write an error into Cursor's hook log.
  begin("a bridged event we deliberately don't map stays a quiet skip");
  const unmapped = await hookClaude({
    ...BRIDGE_SESSION_START,
    hook_event_name: "beforeSubmitPrompt",
  });
  log(`exit=${unmapped.status} stderr=${unmapped.stderr.trim() || "(empty)"}`);
  assert(unmapped.status === 0, `unmapped bridged event exited ${unmapped.status} (expected 0)`);
  assert(unmapped.stderr.trim() === "", "an unmapped bridged event must not write to stderr");
  assert(JSON.parse(unmapped.stdout.trim()).outcome === "skipped", "expected outcome skipped");
  assert(received.length === before, "an unmapped event must not deliver anything");

  log("PASS — bridged Cursor events are delivered as cursor; unknown payloads fail loudly.");
} finally {
  cleanup();
}
