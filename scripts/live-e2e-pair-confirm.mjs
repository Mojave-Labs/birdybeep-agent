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
 * Plus, on every case: the durable token never appears in the CLI's own output.
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
   * Run one full pairing: spawn the real CLI (optionally on a pty), wait for the user code
   * it prints, approve the session as `approver`, then feed `answer` to the prompt (pty
   * cases) and resolve with the CLI's exit code + captured output.
   */
  async function pairCase({ args = [], approver, tty = false, answer }) {
    const { env } = newHome();
    const argv = tty
      ? [PTY_PROXY, process.execPath, CLI_BIN, "pair", ...args]
      : [CLI_BIN, "pair", ...args];
    const child = spawn(tty ? "python3" : process.execPath, argv, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    if (!tty) child.stdin.end(); // a closed pipe: exactly what a script/CI gives the CLI

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
    let approveStatus = 0;
    if (userCode) {
      const res = await fetch(`${baseUrl}/v1/pair/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${approver.bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ user_code: userCode }),
      });
      approveStatus = res.status;
    }

    // 3. answer the prompt once it appears (pty cases only).
    if (tty && answer !== undefined) {
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
      log(
        `─── transcript (pair ${args.join(" ")}${tty ? ` <tty answer=${answer}>` : ""}) ───\n${out}`,
      );
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

  /** No case may ever leak the durable token into the CLI's own output. */
  const assertNoTokenLeak = (label, r) =>
    check(
      `${label}: the durable token never appears in CLI output`,
      r.token === null || !r.out.includes(r.token),
    );

  // ── case 1: interactive DECLINE ───────────────────────────────────────────
  {
    const approver = await makeAccount("decline");
    const r = await pairCase({ approver, tty: true, answer: "n" });
    check(
      "decline: session was really approved server-side (202/200)",
      r.approveStatus < 300,
      `status ${r.approveStatus}`,
    );
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
    const r = await pairCase({ approver, tty: true, answer: "y" });
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
