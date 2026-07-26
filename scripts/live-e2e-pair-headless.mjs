#!/usr/bin/env node
/**
 * LIVE verification of the pairing confirm gate's NON-INTERACTIVE branches, on every OS —
 * the CI-runnable half of birdybeep-md60 (the full live rig, scripts/live-e2e-pair-confirm.mjs,
 * needs the private product repo and a pty, so it cannot run on a Windows runner).
 *
 * Why this exists: the confirm gate made `birdybeep pair` depend on the shape of its stdio, and
 * that is exactly where platforms differ. The controlling-terminal fallback is POSIX-only
 * (`/dev/tty`); Windows has no usable equivalent, so every non-interactive invocation there
 * must take the fail-closed branch. Asserting these branches only on Linux would ship the
 * platform-specific half unverified.
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
 * Case 1 asserts the INVARIANT unconditionally — no token, non-zero exit, no hang — because that
 * must hold however the CLI gets there. Which branch delivers it is environment-dependent, so the
 * rig probes (with a child spawned exactly like the CLI) and asserts the matching message: the
 * fail-closed error where no controlling terminal exists (POSIX `detached`), or prompt-then-
 * fail-closed error where no controlling terminal exists (POSIX `detached`, and ALWAYS on
 * Windows), or prompt-then-decline-on-EOF where /dev/tty is reachable.
 *
 * Run:  node scripts/live-e2e-pair-headless.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, parse as parsePath } from "node:path";
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

/**
 * macOS keychain shim (same approach as the product repo's xrepo rigs).
 *
 * On darwin the token store spawns the real `security` binary. On a headless macOS CI runner
 * `security add-generic-password` blocks on the locked login keychain and never returns — the
 * first windows/macos run of this lane died exactly there (`code null` after the kill timeout,
 * two orphaned `security` processes). That is an environment property, not a product bug (a real
 * user's login keychain is unlocked), so the rig puts a file-backed `security` FIRST on PATH.
 *
 * The CLI's real keychain code path still runs end to end — it spawns `security`, feeds the
 * secret twice over STDIN (never argv), and does its read-back verification — but against this
 * sandbox file instead of the runner's keychain. No-op on Linux/Windows, which never shell out.
 */
const shimDir = join(sandbox, "bin");
mkdirSync(shimDir, { recursive: true });
if (process.platform === "darwin") {
  // Keyed on BIRDYBEEP_FAKE_KEYCHAIN, set per case below: a SHARED store would let one case's
  // token satisfy the next case's "NO token stored" assertion, making it vacuous.
  const shim = `#!/usr/bin/env bash
set -euo pipefail
store="\${BIRDYBEEP_FAKE_KEYCHAIN:?}"
mkdir -p "$store"
cmd="\${1:-}"; shift || true
service=""; account=""; secret=""; wflag=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -s) service="\${2:-}"; shift 2 ;;
    -a) account="\${2:-}"; shift 2 ;;
    -w) wflag=1; shift ;;
    *) shift ;;
  esac
done
file="$store/\${service}__\${account}"
case "$cmd" in
  add-generic-password)
    # The real binary prompts twice and reads both from stdin; a mismatch silently stores an
    # EMPTY password and still exits 0, so reproduce that faithfully.
    if [ "$wflag" -eq 1 ]; then
      IFS= read -r pw1 || pw1=""
      IFS= read -r pw2 || pw2=""
      if [ "$pw1" = "$pw2" ]; then secret="$pw1"; else secret=""; fi
    fi
    printf '%s' "$secret" > "$file"
    ;;
  find-generic-password) if [ -f "$file" ]; then cat "$file"; echo; else exit 44; fi ;;
  delete-generic-password) rm -f "$file" ;;
  *) exit 1 ;;
esac
`;
  writeFileSync(join(shimDir, "security"), shim, { mode: 0o755 });
  chmodSync(join(shimDir, "security"), 0o755);
  log(`macOS: shimming \`security\` on PATH (${shimDir}) — the runner's keychain is locked`);
}

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
      // shimDir first: on darwin this is the file-backed `security` (see above), and the
      // store is scoped to THIS case's home so nothing leaks between cases.
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      BIRDYBEEP_FAKE_KEYCHAIN: join(home, "fake-keychain"),
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

/**
 * Would a child spawned the same way reach a controlling terminal the CLI will actually USE?
 * Windows is always false: `CONIN$` opens on a windows-latest runner but reading it blocks
 * forever, so the CLI deliberately never falls back there (see canOpenControllingTerminal).
 */
function childCanReachTerminal() {
  if (process.platform === "win32") return false;
  const path = "/dev/tty";
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

  // ── case 1: no flags, no answer available ────────────────────────────────
  // The INVARIANT is asserted unconditionally on every platform: piped stdio with nobody to
  // answer must never store a token and must never hang. Which branch delivers that depends on
  // the environment, so the branch-specific message is asserted conditionally:
  //   - no controlling terminal (POSIX `detached`, a console-less runner) → the fail-closed
  //     error, naming both escape hatches (+ the winpty hint on win32);
  //   - /dev/tty IS reachable (a dev box running this from a terminal) → the CLI correctly
  //     PROMPTS on it, reads EOF, and declines.
  // Skipping this case when a terminal happened to be reachable would have left the branch
  // unasserted on exactly the platform the review asked about. On Windows the probe is always
  // false (the CLI never falls back there), so the fail-closed arm is the one that runs.
  {
    approvedByEmail = APPROVER;
    const { env } = newHome();
    const terminalReachable = childCanReachTerminal();
    const r = await runPair([], env);

    check("headless: CLI exits non-zero", r.code !== 0, `code ${r.code}`);
    check("headless: NO token stored", storedToken(env) === null);
    check(
      "headless: never hangs waiting for an answer nobody can give (<30s)",
      r.elapsed < 30_000,
      `${r.elapsed}ms`,
    );

    if (terminalReachable) {
      check(
        "headless (terminal reachable): prompted, then declined on EOF",
        /\[y\/N\]/.test(r.out) && /declined/i.test(r.out),
        r.out.slice(-400),
      );
    } else {
      check(
        "headless (no terminal): error names both escape hatches",
        r.out.includes("--expect-email") && r.out.includes("--yes"),
        r.out.slice(-400),
      );
      if (process.platform === "win32") {
        check(
          "headless (win32, no terminal): points at `winpty birdybeep pair`",
          r.out.includes("winpty birdybeep pair"),
          r.out.slice(-400),
        );
      }
    }
    assertNoLeak("headless", r);
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
