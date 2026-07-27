#!/usr/bin/env node
/**
 * LIVE cross-repo proof for `metadata.session_name` (birdybeep-agent-991) — the WHOLE chain,
 * for real, in one process:
 *
 *   real Claude Code hook payload
 *     → the REAL built `birdybeep hook claude` CLI (token from the strict-perm file store)
 *     → real HTTP POST /v1/agent-events
 *     → the product repo's REAL worker under `wrangler dev` (workerd + local D1/KV/Queues)
 *     → the REAL queue consumer + Expo push client, with `titleFormat = "session_name"` set
 *       through the REAL `PATCH /v1/notification-prefs`
 *     → the push title on the wire.
 *
 * WHY A SEPARATE RIG. The product's own `apps/api/test/integration/title-format-live-e2e.mjs`
 * proves the SERVER half with a hand-written event body, and this repo's adapter tests prove
 * the ADAPTER half against a stub sink. Neither joins them: until this rig, no test had ever
 * shown a real adapter's output composing a real push title. That join is the entire point of
 * 991 — the field exists only so the server can compose — so it gets a real rig.
 *
 * Expo is stubbed at its HTTP boundary (a local server that records what the worker PUTs on
 * the wire) — nothing is ever sent to real Expo/APNs/FCM; real-device delivery stays the human
 * smoke. The CLI's `BIRDYBEEP_API_URL` points at a local TEE PROXY that RECORDS each event body
 * and forwards it verbatim to the live worker, so the run's log contains the exact JSON the
 * adapter put on the wire (evidence, not a claim) without faking any hop.
 *
 * THE DISCRIMINATING CASE (case 2). For a normally-named session the server-composed title is
 * byte-identical to the adapter's own (sv1 already leads the title with the same name), so it
 * cannot on its own distinguish "the server read metadata.session_name" from "the server fell
 * back to the adapter title". So the rig also fires a session with a LONG real name: the server
 * clamps a composed lead (machine-supplied values are untrusted) while pass-through never
 * touches the title, so a composed title is provably NOT the adapter's. Case 3 is the negative
 * control — an unnamed session sends no field and must degrade to the adapter title.
 *
 * Scope note: pairing is done over the real HTTP pairing endpoints and the minted machine token
 * is seeded into the sandbox token store (the same pattern as this repo's other live rigs) —
 * the CLI's own `pair` UX is covered by scripts/live-e2e-pair-*.mjs and the product's xrepo rig.
 *
 * Requirements (SKIP with exit 2 when unmet):
 *   - this repo built (`pnpm build`)
 *   - a sibling product checkout (BIRDYBEEP_REPO, default ../birdybeep) with apps/api/.dev.vars
 *     holding real (non-placeholder) secrets — the authed routes 500 on the examples
 *
 * Run:  node scripts/live-e2e-session-name.mjs
 * Exit: 0 = all checks green; 1 = any failed; 2 = precondition missing.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_BIN = join(REPO, "packages", "cli", "dist", "bin.js");
const AGENT_CORE_DIST = join(REPO, "packages", "agent-core", "dist", "index.js");
const PRODUCT_REPO = process.env.BIRDYBEEP_REPO ?? resolve(REPO, "../birdybeep");
const API_DIR = join(PRODUCT_REPO, "apps/api");
const PORT = Number(process.env.PORT ?? 8801);
const WORKER = `http://127.0.0.1:${PORT}`;

const log = (msg) => console.log(`[live-e2e-session-name] ${msg}`);
function skip(msg) {
  console.error(`[live-e2e-session-name] SKIP: ${msg}`);
  process.exit(2);
}

// ── preconditions ────────────────────────────────────────────────────────────
if (!existsSync(CLI_BIN)) skip(`CLI not built (${CLI_BIN}); run pnpm build`);
if (!existsSync(join(API_DIR, "wrangler.jsonc"))) {
  skip(`no product checkout at ${PRODUCT_REPO} (set BIRDYBEEP_REPO)`);
}
if (!existsSync(join(API_DIR, ".dev.vars"))) {
  skip(`${join(API_DIR, ".dev.vars")} is missing — the worker's authed routes need real secrets`);
}

// ── assertions ───────────────────────────────────────────────────────────────
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "✓ PASS" : "✗ FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name, actual, expected) {
  check(
    name,
    actual === expected,
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

// ── stub Resend: capture the OTP the worker would email (nothing is delivered) ──
const otpByEmail = new Map();
function startStubResend() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw);
        const otp = /\b(\d{6})\b/.exec(body.text ?? "")?.[1];
        if (body.to && otp) otpByEmail.set(body.to, otp);
      } catch {
        /* ignore */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "stub-email" }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// ── stub Expo: record the EXACT messages the worker puts on the wire ──────────
const expoSends = [];
function startStubExpo() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let messages = [];
      try {
        messages = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      if (Array.isArray(messages)) expoSends.push(...messages);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: (Array.isArray(messages) ? messages : []).map((_, i) => ({
            status: "ok",
            id: `rcpt-${expoSends.length}-${i}`,
          })),
        }),
      );
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

/**
 * TEE PROXY — the CLI's backend, transparently. Records every POST /v1/agent-events body (so the
 * run can assert on, and PRINT, the literal JSON the real adapter emitted) and forwards the
 * request unchanged to the live worker, returning the worker's own response. No hop is faked:
 * the CLI still speaks real HTTP, and the worker still receives the real request.
 */
const sentEvents = [];
function startTeeProxy(upstream) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      if (req.method === "POST" && (req.url ?? "").startsWith("/v1/agent-events")) {
        try {
          sentEvents.push(JSON.parse(raw.toString("utf8")));
        } catch {
          /* not JSON — let the worker judge it */
        }
      }
      const headers = {};
      for (const h of ["authorization", "content-type", "accept", "user-agent"]) {
        if (req.headers[h]) headers[h] = req.headers[h];
      }
      try {
        const up = await fetch(`${upstream}${req.url}`, {
          method: req.method,
          headers,
          ...(raw.length > 0 ? { body: raw } : {}),
        });
        const text = await up.text();
        res.writeHead(up.status, {
          "content-type": up.headers.get("content-type") ?? "application/json",
        });
        res.end(text);
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

/** Wait for the queue consumer to deliver a push to the stub and ECHO the wire payload. */
async function nextPush(label, timeoutMs = 20_000) {
  const start = Date.now();
  while (expoSends.length === 0) {
    if (Date.now() - start > timeoutMs) {
      console.log(`   wire ← (nothing captured for ${label} within ${timeoutMs}ms)`);
      return null;
    }
    await sleep(200);
  }
  const push = expoSends.shift();
  console.log(`   wire ← [${label}] ${JSON.stringify({ title: push.title, body: push.body })}`);
  return push;
}

// ── the live worker ──────────────────────────────────────────────────────────
const STATE_DIR = mkdtempSync(join(tmpdir(), "bb-sn-state-"));
const WRANGLER_LOG = join(STATE_DIR, "wrangler.log");

function migrate() {
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", STATE_DIR],
    { cwd: API_DIR, stdio: "inherit" },
  );
}

function startWrangler(resendUrl, expoUrl) {
  return spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--persist-to",
      STATE_DIR,
      "--var",
      "RESEND_API_KEY:re_rig_stub",
      "--var",
      "EMAIL_FROM:birdybeep <login@birdybeep.test>",
      "--var",
      `RESEND_API_URL:${resendUrl}`,
      // The ONLY thing that keeps this off real Expo: the push client's endpoint override.
      "--var",
      `EXPO_PUSH_URL:${expoUrl}`,
    ],
    {
      cwd: API_DIR,
      stdio: ["ignore", openSync(WRANGLER_LOG, "a"), openSync(WRANGLER_LOG, "a")],
      detached: true,
    },
  );
}

function stopWrangler(child) {
  try {
    if (child?.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    /* group already gone */
  }
  try {
    child?.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

async function waitForHealth(timeoutMs = 120_000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${WORKER}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error("wrangler dev never became healthy");
    await sleep(500);
  }
}

// ── real-API helpers (straight to the worker; the CLI goes through the tee) ───
async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${WORKER}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function signIn(email) {
  const send = await api("POST", "/api/auth/email-otp/send-verification-otp", {
    body: { email, type: "sign-in" },
  });
  if (send.status !== 200) throw new Error(`send-verification-otp ${send.status}`);
  const start = Date.now();
  let otp;
  while (!(otp = otpByEmail.get(email))) {
    if (Date.now() - start > 20_000) throw new Error("OTP never captured at the stub");
    await sleep(200);
  }
  const res = await api("POST", "/api/auth/sign-in/email-otp", { body: { email, otp } });
  const token = res.headers.get("set-auth-token") ?? res.body?.token;
  if (!token) throw new Error(`sign-in/email-otp ${res.status}`);
  return token;
}

async function pairMachine(userToken, label) {
  const start = await api("POST", "/v1/pair/start", {
    body: { machine_label: label, os: "linux", cli_version: "0.4.2" },
  });
  const appr = await api("POST", "/v1/pair/approve", {
    token: userToken,
    body: { user_code: start.body.user_code },
  });
  if (appr.body?.approved !== true) throw new Error(`pair/approve ${appr.status}`);
  const tok = await api("POST", "/v1/pair/token", {
    body: { device_code: start.body.device_code, machine_fingerprint: `fp-${label}` },
  });
  if (!tok.body?.machine_token) throw new Error(`pair/token ${tok.status}`);
  return tok.body.machine_token;
}

// ── hermetic sandbox HOME for the CLI (the real machine is never touched) ─────
const sandbox = mkdtempSync(join(tmpdir(), "bb-sn-home-"));
const home = join(sandbox, "home");
const work = join(sandbox, "work");
const bin = join(sandbox, "bin");
for (const d of [home, work, bin, join(home, ".claude")]) mkdirSync(d, { recursive: true });
writeFileSync(join(bin, "birdybeep"), `#!/bin/sh\nexec node "${CLI_BIN}" "$@"\n`);
chmodSync(join(bin, "birdybeep"), 0o755);
// A real checkout so repo/branch detection (and the 0r6 title lead) has something to find.
const checkout = join(work, "myapp");
mkdirSync(join(checkout, ".git"), { recursive: true });
writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");

let proxyUrl = "";
const cliEnv = () => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  PATH: `${bin}:${process.env.PATH}`,
  BIRDYBEEP_API_URL: proxyUrl,
});

/**
 * Run the REAL CLI. ASYNC on purpose: the CLI's request goes through the in-process tee proxy,
 * and `spawnSync` would block this rig's event loop — the proxy could not answer until the child
 * had already given up and queued the event. Awaiting `close` keeps the whole chain synchronous
 * in the way that matters (the child really waits for the worker's 202) without deadlocking it.
 */
function runCli(args, stdin) {
  return new Promise((resolveRun) => {
    const child = spawn("node", [CLI_BIN, ...args], { cwd: checkout, env: cliEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** Fire one REAL Claude Code hook payload through the REAL CLI (JSON on stdin). */
function fireHook(payload) {
  return runCli(["hook", "claude"], JSON.stringify(payload));
}

/** The recorded event matching `predicate`, once the proxy has seen it (it is served async). */
async function recordedEvent(predicate, timeoutMs = 15_000) {
  const start = Date.now();
  for (;;) {
    const hit = sentEvents.find(predicate);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) return undefined;
    await sleep(100);
  }
}

const SHORT_NAME = "billing refactor";
// Long enough that the server MUST clamp its composed lead → the composed title cannot be the
// adapter's own. Under the adapter's 120-char session-name cap, so it survives capture intact.
const LONG_NAME =
  `refactor the billing webhook retry ladder ${"and the dunning emails ".repeat(2)}`.trim();

// ── run ──────────────────────────────────────────────────────────────────────
let wrangler, resend, expo, proxy;
try {
  resend = await startStubResend();
  expo = await startStubExpo();
  proxy = await startTeeProxy(WORKER);
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const resendUrl = `http://127.0.0.1:${resend.address().port}`;
  const expoUrl = `http://127.0.0.1:${expo.address().port}/push`;
  log(`CLI → tee ${proxyUrl} → worker ${WORKER}`);

  log("applying migrations to a throwaway local D1…");
  migrate();
  log(`starting wrangler dev on ${WORKER} (logs: ${WRANGLER_LOG})…`);
  wrangler = startWrangler(resendUrl, expoUrl);
  await waitForHealth();
  check("product worker is live under wrangler dev (GET /health 200)", true);

  const email = `sn-${Date.now()}@birdybeep.test`;
  const userToken = await signIn(email);
  check("real email-OTP sign-in through the live worker", !!userToken);
  const machineToken = await pairMachine(userToken, "sn-rig-box");
  check("real pairing handshake → machine token", machineToken.startsWith("mt_"));

  const dev = await api("POST", "/v1/devices/register", {
    token: userToken,
    body: {
      expo_push_token: "ExponentPushToken[session-name-live-rig]",
      platform: "android",
      device_name: "rig",
    },
  });
  check(
    "device registered (gives the push consumer somewhere to send)",
    dev.status === 200 || dev.status === 201,
    `status ${dev.status}`,
  );

  // The machine token goes into the CLI's own strict-perm store under the sandbox HOME.
  const seed = spawnSync(
    // no backend traffic → safe to block on
    "node",
    [
      "-e",
      `const { setToken } = await import(${JSON.stringify(pathToFileURL(AGENT_CORE_DIST).href)});
       console.log("token store:", await setToken(${JSON.stringify(machineToken)}));`,
    ],
    { env: cliEnv(), encoding: "utf8" },
  );
  check("machine token stored in the CLI's secure store", seed.status === 0, seed.stderr.trim());

  // Real adapter install into the sandbox HOME (what a user actually runs).
  const install = await runCli(["agent", "install", "claude", "--json"]);
  check("`birdybeep agent install claude` → exit 0", install.code === 0, install.stderr.trim());
  check(
    "managed hook command written to the sandbox ~/.claude/settings.json",
    readFileSync(join(home, ".claude", "settings.json"), "utf8").includes("birdybeep hook claude"),
  );

  // The user's phone-side preference, set through the REAL API.
  const prefs = await api("PATCH", "/v1/notification-prefs", {
    token: userToken,
    body: { title_format: "session_name" },
  });
  eq(
    "PATCH /v1/notification-prefs stores title_format=session_name",
    prefs.body?.title_format,
    "session_name",
  );

  /**
   * One case: name the session at SessionStart (the ONLY hook Claude Code puts `session_title`
   * on), then fire a LATER approval hook that carries no name of its own — exactly the sequence
   * a user lives through — and read the push title off the wire.
   */
  async function runCase({ label, sessionId, sessionTitle }) {
    sentEvents.length = 0;
    if (sessionTitle !== undefined) {
      const started = await fireHook({
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: sessionId,
        cwd: checkout,
        session_title: sessionTitle,
        transcript_path: join(home, ".claude", "transcript.jsonl"),
      });
      check(
        `${label}: real SessionStart hook → CLI exit 0`,
        started.code === 0,
        started.stderr.trim(),
      );
    }
    const approval = await fireHook({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      session_id: sessionId,
      cwd: checkout,
      message: "Allow Bash?",
      transcript_path: join(home, ".claude", "transcript.jsonl"),
    });
    check(`${label}: real approval hook → CLI exit 0`, approval.code === 0, approval.stderr.trim());
    const sent = await recordedEvent((e) => e.event_type === "approval_required");
    check(
      `${label}: the approval event reached the worker over real HTTP`,
      !!sent,
      `recorded=${JSON.stringify(sentEvents).slice(0, 500)}`,
    );
    if (sent) console.log(`   wire → [${label}] ${JSON.stringify(sent)}`);
    const push = await nextPush(label);
    return { sent, push };
  }

  // ── CASE 1: a named session — the adapter reports the name, the server leads with it ──
  const one = await runCase({ label: "named", sessionId: "sn-live-1", sessionTitle: SHORT_NAME });
  eq(
    "REAL ADAPTER emits metadata.session_name on the wire",
    one.sent?.metadata?.session_name,
    SHORT_NAME,
  );
  check("named: a push reached the (stubbed) Expo wire", !!one.push, "no push captured");
  eq(
    "named: PUSH TITLE leads with the session name",
    one.push?.title,
    `${SHORT_NAME} — Claude Code needs approval`,
  );

  // ── CASE 2 (DISCRIMINATOR): a LONG real name — a composed title the adapter never wrote ──
  const two = await runCase({
    label: "long-name",
    sessionId: "sn-live-2",
    sessionTitle: LONG_NAME,
  });
  eq(
    "long-name: REAL ADAPTER emits the full session name (adapter cap not hit)",
    two.sent?.metadata?.session_name,
    LONG_NAME,
  );
  const adapterTitle2 = two.sent?.title;
  check(
    "long-name: PUSH TITLE is NOT the adapter's title — the server COMPOSED it from metadata.session_name",
    !!two.push && two.push.title !== adapterTitle2,
    `push=${JSON.stringify(two.push?.title)} adapter=${JSON.stringify(adapterTitle2)}`,
  );
  check(
    "long-name: the composed title still leads with the session name (server-clamped)",
    !!two.push?.title?.startsWith(LONG_NAME.slice(0, 40)),
    JSON.stringify(two.push?.title),
  );

  // ── CASE 3 (NEGATIVE CONTROL): an UNNAMED session sends no field and degrades ──
  const three = await runCase({ label: "unnamed", sessionId: "sn-live-3" });
  check(
    "unnamed: NO session_name key on the wire (absent, not empty)",
    three.sent !== undefined && !("session_name" in (three.sent.metadata ?? {})),
    JSON.stringify(three.sent?.metadata),
  );
  eq(
    "unnamed: PUSH TITLE degrades to the adapter's own repo · branch title",
    three.push?.title,
    "myapp · main — Claude Code needs approval",
  );

  // ── PRIVACY on the wire and in the live worker's logs ──
  const allSent = JSON.stringify(sentEvents);
  check(
    "PRIVACY: no absolute sandbox path in the events the adapter sent",
    !allSent.includes(sandbox),
  );
  check(
    "PRIVACY: the cwd was hashed before it left the machine",
    /"cwd":"h_[0-9a-f]{16}"/.test(allSent),
    allSent.slice(0, 200),
  );
  const logs = readFileSync(WRANGLER_LOG, "utf8");
  for (const [what, secret] of [
    ["the raw session name", LONG_NAME],
    ["the sandbox path", sandbox],
  ]) {
    check(`PRIVACY: ${what} never appears in the live worker's logs`, !logs.includes(secret));
  }
  check(
    "log capture positive control (the worker really logged the ingestion requests)",
    logs.includes("/v1/agent-events"),
  );
} catch (err) {
  check("rig completed without throwing", false, String(err?.stack ?? err));
} finally {
  stopWrangler(wrangler);
  for (const s of [resend, expo, proxy]) s?.close();
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(sandbox, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n── session-name live e2e: ${passed}/${results.length} checks passed ──`);
process.exit(passed === results.length ? 0 : 1);
