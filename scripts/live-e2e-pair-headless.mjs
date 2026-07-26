#!/usr/bin/env node
/**
 * LIVE verification of the pairing confirm gate's NON-INTERACTIVE branches, on every OS —
 * the CI-runnable half of birdybeep-md60 (the full live rig, scripts/live-e2e-pair-confirm.mjs,
 * needs the private product repo and a pty, so it cannot run on a Windows runner).
 *
 * Why this exists: the confirm gate made `birdybeep pair` depend on the shape of its stdio, and
 * that is exactly where platforms differ. Windows has no /dev/tty — the controlling-terminal
 * fallback goes through the `CONIN$` console device, which behaves differently again under a
 * service-style CI runner (no console at all) than under a real terminal. Asserting those
 * branches only on Linux would ship the platform-specific half unverified.
 *
 * Real: the built `birdybeep` binary in its own process, a hermetic temp HOME per case, real
 * pipe stdio, and a real HTTP server speaking the device-code contract. Stubbed: only the
 * backend's two pairing endpoints (this lane must run with no credentials and no sibling repo);
 * the live end-to-end proof against the REAL product worker is live-e2e-pair-confirm.mjs.
 *
 * Cases (all with piped stdio, no answer ever written):
 *   1. no flags            → fails CLOSED, no token, error naming both escape hatches
 *   2. --yes               → pairs, token stored
 *   3. --expect-email MATCH    → pairs unattended, no prompt
 *   4. --expect-email MISMATCH → refuses, no token, names both accounts
 * Plus, on every case: nothing token-shaped in stdout or stderr.
 *
 * Case 1 is only meaningful when the CLI genuinely CANNOT reach a controlling terminal. On
 * POSIX that is forced with `detached: true` (a new session). On Windows it depends on whether
 * the runner has a console, so the rig PROBES first — spawned exactly like the CLI — and, if a
 * console turns out to be reachable, reports case 1 as a skip instead of hanging on a prompt
 * nobody can answer. In CI (no console) the probe fails and the assertion runs for real.
 *
 * Run:  node scripts/live-e2e-pair-headless.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_BIN = join(REPO, "packages", "cli", "dist", "bin.js");
const AGENT_CORE_DIST = join(REPO, "packages", "agent-core", "dist", "index.js");
/** Shaped like a real machine token so the leak assertion is testing the real pattern. */
const MACHINE_TOKEN = `mt_${"a1b2c3d4".repeat(8)}`;
const APPROVER = "approver@birdybeep.test";
const OTHER = "someone-else@birdybeep.test";

const log = (msg) => console.log(`[live-e2e-pair-headless] ${msg}`);
function skipRun(msg) {
  console.error(`[live-e2e-pair-headless] SKIP: ${msg}`);
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "✓ PASS" : "✗ FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function note(name, msg) {
  console.log(`• SKIP  ${name}  — ${msg}`);
}

if (!existsSync(CLI_BIN)) skipRun(`CLI not built (${CLI_BIN}); run pnpm build`);
if (!existsSync(AGENT_CORE_DIST))
  skipRun(`agent-core not built (${AGENT_CORE_DIST}); run pnpm build`);

// ── stub device-code backend (the ONLY stubbed part) ─────────────────────────
let approvedByEmail = APPROVER;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/pair/start") {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          device_code: "dc_headless",
          user_code: "HD-0001",
          qr_payload: "https://birdybeep.com/pair#code=HD-0001",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      );
      return;
    }
    // /v1/pair/token → mint immediately; the gate is what this lane exercises, not the wait.
    res.statusCode = 201;
    res.end(
      JSON.stringify({
        machine_token: MACHINE_TOKEN,
        machine_id: "mac_headless",
        approved_by_email: approvedByEmail,
      }),
    );
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
log(`stub pairing backend at ${baseUrl}`);

const sandbox = mkdtempSync(join(tmpdir(), "bb-pair-headless-"));
let caseNo = 0;
/** A fresh hermetic HOME per case — every profile/config/data var redirected, on every OS. */
function newHome() {
  const home = join(sandbox, `case-${++caseNo}`);
  mkdirSync(home, { recursive: true });
  const root = parsePath(home).root; // e.g. "C:\\" on win32, "/" on POSIX
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ""), // "C:" — must pair with HOMEPATH below
      HOMEPATH: home.slice(root.replace(/[\\/]$/, "").length),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      TMPDIR: join(home, "tmp"),
      TMP: join(home, "tmp"),
      TEMP: join(home, "tmp"),
      BIRDYBEEP_API_URL: baseUrl,
      NO_UPDATE_NOTIFIER: "1",
    },
  };
}

/** Read the token the REAL store resolved for that HOME. */
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
 * Spawn the real CLI with PIPE stdio and no answer available — a script/CI invocation.
 * `detached` on POSIX puts it in a new session so it has no controlling terminal to fall
 * back to; on win32 the absence of a console does the same job.
 */
function runPair(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, "pair", ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(process.platform === "win32" ? {} : { detached: true }),
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d)); // the gate's refusals go to STDERR
    child.stdin.end();
    const started = Date.now();
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 60_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, out, elapsed: Date.now() - started });
    });
  });
}

/** Would a child spawned the same way be able to open a controlling terminal? */
function childCanReachTerminal() {
  const path = process.platform === "win32" ? "\\\\.\\CONIN$" : "/dev/tty";
  const res = spawnSync(
    process.execPath,
    [
      "-e",
      `const fs=require("node:fs");try{fs.closeSync(fs.openSync(${JSON.stringify(path)},"r"));console.log("yes")}catch{console.log("no")}`,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      ...(process.platform === "win32" ? {} : { detached: true }),
      windowsHide: true,
    },
  );
  return res.stdout.trim() === "yes";
}

const TOKEN_SHAPE = /mt_[0-9a-f]{64}/;
const assertNoLeak = (label, r) =>
  check(`${label}: no machine token in CLI output`, !TOKEN_SHAPE.test(r.out), r.out.slice(-200));

try {
  log(
    `platform=${process.platform}; controlling terminal reachable by a child: ${childCanReachTerminal()}`,
  );

  // ── case 1: no flags, no terminal → fail CLOSED ───────────────────────────
  {
    approvedByEmail = APPROVER;
    const { env } = newHome();
    if (childCanReachTerminal()) {
      // A real console is attached (a dev running this locally), so the CLI would correctly
      // PROMPT — and nothing here could answer it. Skip rather than hang; CI has no console.
      note(
        "headless: fails closed with no terminal",
        "a controlling terminal is reachable here, so the CLI would prompt (expected on a dev box; CI has no console)",
      );
    } else {
      const r = await runPair([], env);
      check("headless: CLI exits non-zero", r.code !== 0, `code ${r.code}`);
      check("headless: NO token stored", storedToken(env) === null);
      check(
        "headless: error names both escape hatches",
        r.out.includes("--expect-email") && r.out.includes("--yes"),
        r.out.slice(-400),
      );
      check(
        "headless: fails fast rather than hanging (<20s)",
        r.elapsed < 20_000,
        `${r.elapsed}ms`,
      );
      if (process.platform === "win32") {
        check(
          "headless (win32): points at `winpty birdybeep pair`",
          r.out.includes("winpty birdybeep pair"),
          r.out.slice(-400),
        );
      }
      assertNoLeak("headless", r);
    }
  }

  // ── case 2: --yes ─────────────────────────────────────────────────────────
  {
    approvedByEmail = APPROVER;
    const { env } = newHome();
    const r = await runPair(["--yes"], env);
    check("--yes: CLI exits 0", r.code === 0, `code ${r.code} out=${r.out.slice(-400)}`);
    check("--yes: token stored", storedToken(env) === MACHINE_TOKEN);
    check("--yes: never printed a prompt", !/\[y\/N\]/.test(r.out));
    assertNoLeak("--yes", r);
  }

  // ── case 3: --expect-email MATCH ──────────────────────────────────────────
  {
    approvedByEmail = APPROVER;
    const { env } = newHome();
    const r = await runPair(["--expect-email", APPROVER], env);
    check(
      "--expect-email match: CLI exits 0",
      r.code === 0,
      `code ${r.code} out=${r.out.slice(-400)}`,
    );
    check("--expect-email match: token stored", storedToken(env) === MACHINE_TOKEN);
    check("--expect-email match: never prompted", !/\[y\/N\]/.test(r.out));
    assertNoLeak("--expect-email match", r);
  }

  // ── case 4: --expect-email MISMATCH ───────────────────────────────────────
  {
    approvedByEmail = OTHER; // a different account approved it than the one pinned
    const { env } = newHome();
    const r = await runPair(["--expect-email", APPROVER], env);
    check("--expect-email mismatch: CLI exits non-zero", r.code !== 0, `code ${r.code}`);
    check("--expect-email mismatch: NO token stored", storedToken(env) === null);
    check(
      "--expect-email mismatch: names both accounts",
      r.out.includes(OTHER) && r.out.includes(APPROVER),
      r.out.slice(-400),
    );
    assertNoLeak("--expect-email mismatch", r);
  }
} catch (err) {
  check("harness ran without throwing", false, err?.stack ?? String(err));
} finally {
  server.close();
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
