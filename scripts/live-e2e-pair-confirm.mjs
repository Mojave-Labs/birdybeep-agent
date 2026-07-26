#!/usr/bin/env node
/**
 * LIVE end-to-end verification of the pairing confirm gate (birdybeep-md60) — § CLAUDE.md
 * "real end-to-end testing". No stubs on either side:
 *
 *   - the REAL built `birdybeep` CLI binary, exec'd as its own process in a hermetic
 *     temp HOME (a fresh one per case, so token state can never leak between them);
 *   - the REAL built product worker (`birdybeep` sibling repo, bundled by wrangler and
 *     served by programmatic Miniflare — the same workerd runtime `wrangler dev` wraps,
 *     with real D1/KV/Queues/DO bindings and all migrations applied);
 *   - the REAL device-code handshake: the CLI drives POST /v1/pair/start and polls
 *     POST /v1/pair/token while this driver approves out-of-band via the authed
 *     POST /v1/pair/approve, exactly as the mobile app does — which is what makes the
 *     server report a genuine `approved_by_email`;
 *   - a REAL pty for the interactive cases, so `process.stdin.isTTY` is true and the
 *     CLI's prompt engages (scripts/lib/pty-proxy.py), with the true exit code observed.
 *
 * Proves, against that live stack:
 *   1. DECLINE  — answering "n" leaves NO token in the store and exits non-zero.
 *   2. ACCEPT   — answering "y" stores the minted token.
 *   3. --yes    — pairs unattended with no tty at all.
 *   4. --expect-email MATCH    — pairs unattended, no prompt.
 *   5. --expect-email MISMATCH — refuses and stores NO token (the wrong-account case,
 *      driven by a second real account approving the session).
 *   6. headless, no flags — fails CLOSED fast (never hangs a script), naming both hatches.
 *   7. PIPED stdin under a controlling terminal — the pipe-backed-shell shape: the prompt must
 *      still engage and read from /dev/tty rather than fail closed, for BOTH answers, and the
 *      process must exit promptly afterwards (an exact exit code + a time bound, because a
 *      SIGKILLed hang also produces a non-zero "code").
 * Plus, on every case: nothing token-SHAPED ever appears in the CLI's own output (stdout AND
 * stderr), which is the check that actually covers the reject paths — they store no token, so a
 * stored-value comparison alone would inspect zero bytes on exactly the paths that hold a live
 * minted-then-discarded credential.
 *
 * Needs the SIBLING product repo checked out + installed (its node_modules provide
 * miniflare/better-auth); it is never modified — the worker secrets are generated here and
 * injected as Miniflare bindings, and the wrangler bundle is written to a temp dir. Exits 2
 * (SKIP) when a precondition is missing, so it can be wired into a lane without going red.
 *
 * Run:  node scripts/live-e2e-pair-confirm.mjs
 *       BIRDYBEEP_REPO=/path/to/birdybeep node scripts/live-e2e-pair-confirm.mjs
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const AGENT_REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PRODUCT_REPO = process.env.BIRDYBEEP_REPO ?? join(AGENT_REPO, "..", "birdybeep");
const API_DIR = join(PRODUCT_REPO, "apps", "api");
const MIGRATIONS_DIR = join(API_DIR, "migrations");
const CLI_BIN = join(AGENT_REPO, "packages", "cli", "dist", "bin.js");
const AGENT_CORE_DIST = join(AGENT_REPO, "packages", "agent-core", "dist", "index.js");
const PTY_PROXY = join(AGENT_REPO, "scripts", "lib", "pty-proxy.py");

const log = (msg) => console.log(`[live-e2e-pair-confirm] ${msg}`);
function skip(msg) {
  console.error(`[live-e2e-pair-confirm] SKIP: ${msg}`);
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "✓ PASS" : "✗ FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

// ── preconditions ────────────────────────────────────────────────────────────
if (process.platform === "win32") skip("POSIX-only (the interactive cases need a pty)");
if (!existsSync(CLI_BIN)) skip(`CLI not built (${CLI_BIN}); run pnpm build`);
if (!existsSync(AGENT_CORE_DIST)) skip(`agent-core not built (${AGENT_CORE_DIST}); run pnpm build`);
if (!existsSync(MIGRATIONS_DIR))
  skip(`product repo not found at ${PRODUCT_REPO} (set BIRDYBEEP_REPO)`);
if (spawnSync("python3", ["-c", "import pty"]).status !== 0) skip("python3 with `pty` is required");

// The sibling repo owns miniflare/better-auth; resolve them from ITS node_modules so this
// public repo never takes a dependency on the private product's toolchain.
const requireFromApi = createRequire(join(API_DIR, "package.json"));
async function importFromProduct(name) {
  return import(pathToFileURL(requireFromApi.resolve(name)).href);
}
let Miniflare, betterAuth, bearer, withCloudflare;
try {
  ({ Miniflare } = await importFromProduct("miniflare"));
  ({ betterAuth } = await importFromProduct("better-auth"));
  ({ bearer } = await importFromProduct("better-auth/plugins"));
  ({ withCloudflare } = await importFromProduct("better-auth-cloudflare"));
} catch (err) {
  skip(`product deps not installed (${err?.message ?? err}); run pnpm install in ${PRODUCT_REPO}`);
}

/**
 * Worker secrets for THIS run only, generated here so the sibling repo's `.dev.vars` is
 * neither read nor written. They must clear apps/api's startup validation: >=32 chars, a
 * KEK that base64-decodes to exactly 32 bytes, and no known placeholder value.
 */
const BINDINGS = {
  BETTER_AUTH_SECRET: `pair-confirm-e2e-${randomBytes(24).toString("hex")}`,
  MACHINE_TOKEN_PEPPER: `pair-confirm-e2e-pepper-${randomBytes(16).toString("hex")}`,
  DB_ENCRYPTION_KEK: randomBytes(32).toString("base64"),
};

async function applyMigrations(db) {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
      .split("\n")
      .map((line) => {
        const i = line.indexOf("--");
        return i >= 0 ? line.slice(0, i) : line;
      })
      .join("\n");
    for (const stmt of sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await db.prepare(stmt).run();
    }
  }
}

let mf, bundleDir, sandbox;
try {
  // ── bundle the REAL worker (no upload, no account, no login) ──────────────
  bundleDir = mkdtempSync(join(tmpdir(), "bb-pairconfirm-worker-"));
  log("bundling the product worker (wrangler deploy --dry-run)…");
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", bundleDir], {
    cwd: API_DIR,
    stdio: "inherit",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });

  mf = new Miniflare({
    modules: [
      {
        type: "ESModule",
        path: join(bundleDir, "index.js"),
        contents: readFileSync(join(bundleDir, "index.js"), "utf8"),
      },
    ],
    modulesRoot: bundleDir,
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "birdybeep-spike" },
    kvNamespaces: { KV: "birdybeep-kv" },
    // Required binding: without it the worker's env validation 500s every pairing route.
    durableObjects: { RATE_LIMITER: { className: "RateLimiterDO", useSQLite: true } },
    queueProducers: { PUSH_QUEUE: "birdybeep-push" },
    queueConsumers: { "birdybeep-push": { maxBatchSize: 10, maxRetries: 3 } },
    bindings: { ...BINDINGS },
  });
  const baseUrl = (await mf.ready).origin;
  const db = await mf.getD1Database("DB");
  const kv = await mf.getKVNamespace("KV");
  await applyMigrations(db);
  log(`live worker at ${baseUrl}`);

  const health = await fetch(`${baseUrl}/health`);
  check(
    "product worker boots (GET /health → 200)",
    health.status === 200,
    `status ${health.status}`,
  );

  // ── test-only session mint (stands in for the mobile app's signed-in user) ─
  // Better Auth keeps sessions in KV (secondaryStorage), so a twin over the SAME D1+KV is
  // the only backdoor-free way to hold a bearer the live worker accepts. Mirrors the
  // product repo's own xrepo rigs.
  const twin = betterAuth({
    baseURL: baseUrl,
    secret: BINDINGS.BETTER_AUTH_SECRET,
    ...withCloudflare(
      { d1Native: db, kv, autoDetectIpAddress: false, geolocationTracking: false },
      { emailAndPassword: { enabled: true }, plugins: [bearer()], rateLimit: { enabled: false } },
    ),
  });
  /** Create a real account (Better Auth user + the product `users` row userAuth reads). */
  async function makeAccount(tag) {
    const email = `${tag}-${randomUUID().slice(0, 8)}@birdybeep.test`;
    const signUp = await twin.api.signUpEmail({
      body: { email, password: "pair-confirm-ABC-12345", name: "Pair Confirm" },
    });
    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT OR IGNORE INTO users (id,email,display_name,created_at,updated_at) VALUES (?,?,?,?,?)",
      )
      .bind(signUp.user.id, email, "Pair Confirm", now, now)
      .run();
    return { email, bearer: signUp.token };
  }

  sandbox = mkdtempSync(join(tmpdir(), "bb-pairconfirm-home-"));
  let caseNo = 0;
  /** A fresh hermetic HOME per case: no token, config, or install salt is ever shared. */
  function newHome() {
    const home = join(sandbox, `case-${++caseNo}`);
    mkdirSync(home, { recursive: true });
    return {
      home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        BIRDYBEEP_API_URL: baseUrl,
        // A pty makes stderr a tty, which would otherwise wake the npm update notifier.
        NO_UPDATE_NOTIFIER: "1",
      },
    };
  }

  /** Read the token the REAL store resolved for that HOME (keychain-less Linux → file). */
  function storedToken(env) {
    const res = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { getToken } = await import(${JSON.stringify(pathToFileURL(AGENT_CORE_DIST).href)});
         console.log(JSON.stringify(await getToken()));`,
      ],
      { env, encoding: "utf8" },
    );
    if (res.status !== 0) throw new Error(`token read failed: ${res.stderr}`);
    return JSON.parse(res.stdout.trim());
  }

  /**
   * Run one full pairing: spawn the real CLI, wait for the user code it prints, approve the
   * session as `approver`, then feed `answer` to the prompt and resolve with the CLI's exit
   * code + captured output.
   *
   * `mode` decides what the CLI's stdio actually IS — the whole point of the confirm gate:
   *   "pipe"            stdin is a closed pipe and there is no controlling terminal (a script/CI).
   *   "tty"             stdin IS the terminal (a human in a normal shell).
   *   "piped-stdin-tty" stdin is a PIPE but a controlling terminal exists — the Git-Bash-without-
   *                     ConPTY shape. Built by running the CLI inside a pty (so /dev/tty resolves)
   *                     with its stdin redirected from a real pipe. The answer we write goes to
   *                     the pty master, so it reaches the CLI only if it truly read /dev/tty.
   * Both stdout AND stderr are captured into `out` — the gate's refusal/decline messages go to
   * stderr (ctx.io.errline), so an stdout-only capture would assert against nothing.
   */
  async function pairCase({ args = [], approver, mode = "pipe", answer }) {
    const { env } = newHome();
    const pairArgs = ["pair", ...args];
    let command;
    let argv;
    if (mode === "tty") {
      command = "python3";
      argv = [PTY_PROXY, process.execPath, CLI_BIN, ...pairArgs];
    } else if (mode === "piped-stdin-tty") {
      // `printf '' |` gives the CLI a genuine pipe on fd 0 while the pty stays its controlling
      // terminal; `exec` keeps the exit status the CLI's own.
      const shell = [process.execPath, CLI_BIN, ...pairArgs]
        .map((a) => JSON.stringify(a))
        .join(" ");
      command = "python3";
      argv = [PTY_PROXY, "sh", "-c", `printf '' | exec ${shell}`];
    } else {
      command = process.execPath;
      argv = [CLI_BIN, ...pairArgs];
    }
    const child = spawn(command, argv, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // A new session (setsid) for the plain-pipe case: without it the rig's OWN controlling
      // terminal would be inherited, the CLI would take the /dev/tty fallback, and the
      // "headless fails closed" case would silently stop testing what it claims to.
      ...(mode === "pipe" ? { detached: true } : {}),
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    if (mode === "pipe") child.stdin.end(); // a closed pipe: exactly what a script/CI gives the CLI

    // 1. wait for the code the CLI printed, 2. approve it as the mobile app would.
    let userCode = null;
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
      const m = /Code:\s*([A-Z0-9-]{4,})/.exec(out);
      if (m) {
        userCode = m[1];
        break;
      }
      await sleep(100);
    }
    // -1, not 0: a case where the code never appeared (so approve was never called) must FAIL
    // the "was really approved" check, not sail past a `< 300` comparison.
    let approveStatus = -1;
    if (userCode) {
      const res = await fetch(`${baseUrl}/v1/pair/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${approver.bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ user_code: userCode }),
      });
      approveStatus = res.status;
    }

    // 3. answer the prompt once it appears (terminal-backed cases only).
    if (mode !== "pipe" && answer !== undefined) {
      for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
        if (/\[y\/N\]/.test(out)) break;
        await sleep(100);
      }
      child.stdin.write(`${answer}\n`);
    }

    const approvedAt = Date.now();
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const code = await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(killer);
    // BIRDYBEEP_E2E_TRANSCRIPT=1 dumps what the operator actually saw — the source of truth
    // when checking that docs/pairing.md quotes the real output.
    if (process.env.BIRDYBEEP_E2E_TRANSCRIPT) {
      log(`─── transcript (pair ${args.join(" ")} [${mode}] answer=${answer ?? "—"}) ───\n${out}`);
    }
    return {
      code,
      out,
      userCode,
      approveStatus,
      env,
      elapsedAfterApprove: Date.now() - approvedAt,
      token: storedToken(env),
    };
  }

  /**
   * No case may ever leak a durable token into the CLI's own output.
   *
   * The SHAPE check is the load-bearing one and runs on every case. A stored-value-only check
   * short-circuits on precisely the cases that matter — decline, pin mismatch, headless — because
   * those store no token, so `r.token === null` would pass without inspecting a single byte of
   * output, even though those are the paths holding a minted-but-discarded live credential.
   * The stored-value check stays as a second, narrower net.
   */
  // Deliberately loose: `{8,}` rather than the exact `{64}`, so a TRUNCATED print (a debug line
  // showing the first N chars of the token) is caught too — a prefix is still credential material.
  // Sanity-checked against the legitimate output of every case below: emails, machine ids
  // (`mac_…`), user codes and the QR block contain no `mt_<hex>` run.
  const MACHINE_TOKEN_SHAPE = /mt_[0-9a-f]{8,}/;
  const assertNoTokenLeak = (label, r) => {
    check(
      `${label}: no machine token in CLI output`,
      !MACHINE_TOKEN_SHAPE.test(r.out),
      r.out.slice(-200),
    );
    if (r.token !== null) {
      check(`${label}: the stored token specifically never appears`, !r.out.includes(r.token));
    }
  };
  /** Every case that drives /v1/pair/approve must prove the approval actually happened. */
  const assertApproved = (label, r) =>
    check(
      `${label}: session was really approved server-side`,
      r.approveStatus > 0 && r.approveStatus < 300,
      `status ${r.approveStatus}`,
    );

  // ── case 1: interactive DECLINE ───────────────────────────────────────────
  {
    const approver = await makeAccount("decline");
    const r = await pairCase({ approver, mode: "tty", answer: "n" });
    assertApproved("decline", r);
    check(
      "decline: the prompt named the approving account",
      r.out.includes(approver.email) && /\[y\/N\]/.test(r.out),
      r.out.slice(-500),
    );
    check("decline: CLI exits non-zero", r.code !== 0, `code ${r.code}`);
    check("decline: NO token was stored", r.token === null, `token=${r.token}`);
    check(
      "decline: says it was declined + how to revoke",
      /declined/i.test(r.out) && /revoke/i.test(r.out),
    );
    assertNoTokenLeak("decline", r);
  }

  // ── case 2: interactive ACCEPT ────────────────────────────────────────────
  {
    const approver = await makeAccount("accept");
    const r = await pairCase({ approver, mode: "tty", answer: "y" });
    assertApproved("accept", r);
    check("accept: CLI exits 0", r.code === 0, `code ${r.code} out=${r.out.slice(-500)}`);
    check(
      "accept: a real machine token was stored (mt_…)",
      typeof r.token === "string" && /^mt_[0-9a-f]{64}$/.test(r.token),
      `token=${r.token}`,
    );
    check("accept: reports the account it paired to", r.out.includes(approver.email));
    assertNoTokenLeak("accept", r);
  }

  // ── case 3: --yes with NO tty at all ──────────────────────────────────────
  {
    const approver = await makeAccount("yesflag");
    const r = await pairCase({ approver, args: ["--yes"] });
    assertApproved("--yes", r);
    check(
      "--yes: CLI exits 0 with no tty",
      r.code === 0,
      `code ${r.code} out=${r.out.slice(-500)}`,
    );
    check("--yes: token stored", typeof r.token === "string" && r.token.startsWith("mt_"));
    check("--yes: never printed a prompt", !/\[y\/N\]/.test(r.out));
    assertNoTokenLeak("--yes", r);
  }

  // ── case 4: --expect-email MATCH ──────────────────────────────────────────
  {
    const approver = await makeAccount("pinmatch");
    const r = await pairCase({ approver, args: ["--expect-email", approver.email] });
    assertApproved("--expect-email match", r);
    check(
      "--expect-email match: CLI exits 0",
      r.code === 0,
      `code ${r.code} out=${r.out.slice(-500)}`,
    );
    check(
      "--expect-email match: token stored",
      typeof r.token === "string" && r.token.startsWith("mt_"),
    );
    check("--expect-email match: never prompted", !/\[y\/N\]/.test(r.out));
    assertNoTokenLeak("--expect-email match", r);
  }

  // ── case 5: --expect-email MISMATCH (a different real account approves) ───
  {
    const approver = await makeAccount("attacker");
    const expected = await makeAccount("expected");
    const r = await pairCase({ approver, args: ["--expect-email", expected.email] });
    assertApproved("--expect-email mismatch", r);
    check("--expect-email mismatch: CLI exits non-zero", r.code !== 0, `code ${r.code}`);
    check("--expect-email mismatch: NO token stored", r.token === null, `token=${r.token}`);
    check(
      "--expect-email mismatch: names the account that actually approved it",
      r.out.includes(approver.email) && r.out.includes(expected.email),
      r.out.slice(-500),
    );
    assertNoTokenLeak("--expect-email mismatch", r);
  }

  // ── case 6: headless with no escape hatch → fail CLOSED, fast ─────────────
  {
    const approver = await makeAccount("headless");
    const r = await pairCase({ approver });
    assertApproved("headless", r);
    check("headless: CLI exits non-zero", r.code !== 0, `code ${r.code}`);
    check("headless: NO token stored", r.token === null, `token=${r.token}`);
    check(
      "headless: error teaches both escape hatches",
      r.out.includes("--expect-email") && r.out.includes("--yes"),
      r.out.slice(-500),
    );
    check(
      "headless: fails fast instead of hanging a script (<15s after approval)",
      r.elapsedAfterApprove < 15_000,
      `${r.elapsedAfterApprove}ms`,
    );
    assertNoTokenLeak("headless", r);
  }

  // ── case 7: PIPED stdin but a controlling terminal exists (the Git Bash shape) ──
  // stdin is a real pipe, so `process.stdin.isTTY` is false — yet a terminal IS attached, so the
  // gate must prompt on /dev/tty rather than fail closed. The answer is written to the pty master,
  // so it can only reach the CLI if it genuinely opened the controlling terminal.
  //
  // BOTH answers are exercised, and the assertions are built to SEE A HANG. `r.code !== 0` alone
  // cannot: pairCase SIGKILLs at 60s and `code` is then `null`, which is `!== 0` — so a one-minute
  // hang scored PASS. Each arm now pins an EXACT exit code (null therefore fails) AND a time bound
  // measured from the approval, which is what catches the process staying alive after the answer
  // has been read — exactly the fs-read-stream defect this rig surfaced.
  for (const { answer, label, wantCode, wantToken } of [
    { answer: "n", label: "/dev/tty decline", wantCode: 1, wantToken: false },
    { answer: "y", label: "/dev/tty accept", wantCode: 0, wantToken: true },
  ]) {
    const approver = await makeAccount("devtty");
    const r = await pairCase({ approver, mode: "piped-stdin-tty", answer });
    assertApproved(label, r);
    check(
      `${label}: the prompt engaged despite piped stdin`,
      /\[y\/N\]/.test(r.out) && r.out.includes(approver.email),
      r.out.slice(-500),
    );
    check(
      `${label}: exits ${wantCode} (a null code would mean it was killed mid-hang)`,
      r.code === wantCode,
      `code ${r.code}`,
    );
    check(
      `${label}: the process exits promptly after the answer (<15s)`,
      r.elapsedAfterApprove < 15_000,
      `${r.elapsedAfterApprove}ms after approval`,
    );
    check(
      `${label}: token ${wantToken ? "stored" : "NOT stored"}`,
      wantToken ? typeof r.token === "string" && r.token.startsWith("mt_") : r.token === null,
      `token=${r.token}`,
    );
    check(`${label}: did not fail closed`, !/no terminal to ask on/.test(r.out), r.out.slice(-300));
    assertNoTokenLeak(label, r);
  }

  // ── server-side: a declined pairing still minted a machine row (revoke advice) ──
  const installs = await db.prepare("SELECT COUNT(*) AS n FROM machine_installations").first();
  log(`machine_installations rows after all cases: ${installs.n}`);
} catch (err) {
  check("harness ran without throwing", false, err?.stack ?? String(err));
} finally {
  try {
    await mf?.dispose();
  } catch {
    /* already down */
  }
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
  if (sandbox && !process.env.BIRDYBEEP_E2E_KEEP) rmSync(sandbox, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
