#!/usr/bin/env node
/**
 * LIVE end-to-end verification for the Cursor adapter (§ CLAUDE.md "real
 * end-to-end testing"). Drives the REAL `cursor-agent` binary end to end:
 *
 *   1. hermetic sandbox HOME (never touches the real machine)
 *   2. the adapter is installed the REAL way — `birdybeep agent install cursor`
 *      writes ~/.cursor/hooks.json (version 1) with `birdybeep hook cursor`
 *      entries; we assert the managed entries landed non-destructively
 *   3. machine token seeded into the strict-perm FILE store (no keychain in CI)
 *   4. a real `cursor-agent -p --trust` session (no tools, so no approval gate is
 *      dropped) — headless cursor-agent fires sessionStart + sessionEnd
 *   5. each fired hook spawns the real `birdybeep hook cursor` CLI; events must
 *      arrive at a local stub sink with the right types, Bearer token, hashed cwd,
 *      and — the headline privacy assertion — NO user_email and NO transcript_path
 *   6. sessionEnd{final_status:"completed"} → agent_completed is the CLI completion
 *      beep (cursor-agent -p never fires `stop`), so we assert it is delivered.
 *
 * Requirements (SKIP with exit 2 when unmet):
 *   - `cursor-agent` on PATH (tested against 2026.07.x)
 *   - CURSOR_API_KEY env var (a Cursor account key; bills account credits)
 *   - repo built (`pnpm build`)
 *
 * Run:  node scripts/live-e2e-cursor.mjs
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
const TOKEN = "bbm_live_e2e_cursor_token";
const CURSOR_KEY = process.env.CURSOR_API_KEY ?? "";

const log = (msg) => console.log(`[live-e2e-cursor] ${msg}`);
const fail = (msg) => {
  console.error(`[live-e2e-cursor] FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};
const skip = (msg) => {
  console.error(`[live-e2e-cursor] SKIP: ${msg}`);
  process.exit(2);
};
const assert = (cond, msg) => {
  if (!cond) fail(msg);
};
const begin = (msg) => log(`▶ ${msg}`);

if (!existsSync(CLI_BIN)) skip(`CLI not built (${CLI_BIN}) — run pnpm build`);
if (CURSOR_KEY === "") skip("CURSOR_API_KEY not set");
const cvVersion = spawnSync("cursor-agent", ["--version"], { encoding: "utf8" });
if (cvVersion.status !== 0) skip("cursor-agent binary not on PATH");
log(`cursor-agent: ${cvVersion.stdout.trim()}`);

const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-live-cursor-"));
const home = join(sandbox, "home");
const work = join(sandbox, "work");
const bin = join(sandbox, "bin");
for (const d of [home, work, bin]) mkdirSync(d, { recursive: true });

// birdybeep on PATH — the hooks.json command is the bare name `birdybeep hook cursor`.
writeFileSync(join(bin, "birdybeep"), `#!/bin/sh\nexec node "${CLI_BIN}" "$@"\n`);
chmodSync(join(bin, "birdybeep"), 0o755);

let sinkUrl = "";
const makeBaseEnv = () => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  PATH: `${bin}:${process.env.PATH}`,
  CURSOR_API_KEY: CURSOR_KEY,
  BIRDYBEEP_API_URL: sinkUrl,
});

function birdybeep(args, env = {}) {
  return spawnSync("node", [CLI_BIN, ...args, "--json"], {
    cwd: work,
    env: { ...makeBaseEnv(), ...env },
    encoding: "utf8",
  });
}
/** Async spawn — keeps the event loop free so the in-process stub sink can answer hooks. */
async function runAsync(cmd, args, { env = {}, timeoutMs = 150_000 } = {}) {
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
  // ── 1. seed the machine token into the FILE store ─────────────────────────
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

  // ── 2. REAL install: birdybeep agent install cursor → ~/.cursor/hooks.json ─
  begin("birdybeep agent install cursor (writes hooks.json)");
  const inst = birdybeep(["agent", "install", "cursor"]);
  assert(inst.status === 0, `install failed: ${inst.stderr || inst.stdout}`);
  const hooksPath = join(home, ".cursor", "hooks.json");
  assert(existsSync(hooksPath), `hooks.json not written at ${hooksPath}`);
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert(hooks.version === 1, `hooks.json version !== 1 (${hooks.version})`);
  const hasBirdy = Object.values(hooks.hooks ?? {}).some(
    (arr) => Array.isArray(arr) && arr.some((e) => e?.command === "birdybeep hook cursor"),
  );
  assert(hasBirdy, "hooks.json has no `birdybeep hook cursor` entry");
  log(`hooks.json events: ${Object.keys(hooks.hooks ?? {}).join(", ")}`);

  // ── 3. real cursor-agent session (no tools → no approval gate dropped) ─────
  begin(`real cursor-agent session (headless, --trust)`);
  const runOut = await runAsync(
    "cursor-agent",
    ["-p", "--trust", "Reply with exactly the word: pong"],
    { timeoutMs: 150_000 },
  );
  log(`cursor-agent exit=${runOut.status}`);

  // ── 4. await delivery to the stub sink ────────────────────────────────────
  begin("await event delivery to the stub sink");
  const want = ["session_started", "agent_completed"];
  const deadline = Date.now() + 20_000;
  const have = () => new Set(received.map((r) => r.body?.event_type));
  while (Date.now() < deadline && !want.every((w) => have().has(w))) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const types = [...have()];
  log(`received event types: ${types.join(", ") || "(none)"}`);
  for (const w of want) assert(have().has(w), `expected a ${w} event; got [${types.join(", ")}]`);

  // ── 5. privacy + shape assertions on every delivered event ────────────────
  begin("assert Bearer + hashed cwd + NO PII (user_email/transcript_path)");
  for (const r of received) {
    const ev = r.body;
    if (typeof ev !== "object" || ev === null) continue;
    assert(
      r.headers["authorization"] === `Bearer ${TOKEN}`,
      `missing/wrong Bearer on ${ev.event_type}`,
    );
    assert(
      typeof ev.workspace?.cwd === "string" && /^h_[0-9a-f]{16}$/.test(ev.workspace.cwd),
      `cwd not hashed on ${ev.event_type}: ${ev.workspace?.cwd}`,
    );
    const serialized = JSON.stringify(r);
    for (const leak of ["user_email", "transcript_path", ".jsonl", work, home]) {
      assert(!serialized.includes(leak), `PII/path leak (${leak}) in ${ev.event_type}`);
    }
    assert(ev.harness === "cursor", `harness !== cursor on ${ev.event_type}`);
  }

  log(
    `✅ PASS — real cursor-agent → installed hooks.json → hook → sink; ${received.length} event(s), no PII`,
  );
} finally {
  cleanup();
}
