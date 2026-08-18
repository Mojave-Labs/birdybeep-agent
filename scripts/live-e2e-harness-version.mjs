#!/usr/bin/env node
/**
 * LIVE end-to-end verification that `harness_version` names the engine that ACTUALLY ran
 * (birdybeep-agent-gcgp.7). Drives real harness binaries in hermetic sandboxes and asserts the
 * delivered event's `harness_version` equals what that binary's own `--version` reports.
 *
 * The measurement only means something when the same harness is installed twice on one machine
 * from two update channels, which is the normal case:
 *
 *   Claude Code   terminal CLI on PATH        vs  the engine bundled in the desktop app
 *                 (~/.local/bin/claude)           (~/Library/Application Support/Claude/claude-code/<v>/)
 *   Codex         terminal CLI on PATH        vs  the build bundled in ChatGPT.app
 *                 — both reading ONE ~/.codex/config.toml, so nothing but the reported
 *                   version can tell their events apart
 *
 * A `<harness> --version` probe of whatever is on PATH would answer the same for both, which is
 * exactly the failure this field exists to prevent. So each leg asserts against the version of
 * the binary it launched, not against PATH.
 *
 * The assertion does NOT depend on the model turn succeeding: lifecycle hooks fire on session
 * start/end regardless of auth, and it is the hook payload/env that carries the version. No
 * model API key is required.
 *
 * Legs auto-skip when their binary is absent, so this is useful on a partly-provisioned machine.
 * Exit 0 = every runnable leg passed, 1 = a leg failed, 2 = nothing was runnable.
 *
 * Codex precondition: Codex refuses to run untrusted `[[hooks.X]]` commands, and granting trust
 * needs its interactive /hooks dialog. Rather than forge anything, the Codex legs COPY the
 * `[hooks.state]` trusted_hash entries out of an already-trusted config on this machine
 * (`$CODEX_HOME` or `~/.codex/config.toml`, read-only) into the sandbox. Install writes
 * byte-identical hook entries, so the hashes still match. No trusted config → the Codex legs skip.
 *
 * Run:  node scripts/live-e2e-harness-version.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_BIN = join(REPO, "packages", "cli", "dist", "bin.js");
const AGENT_CORE_DIST = join(REPO, "packages", "agent-core", "dist", "index.js");
const TOKEN = "bbm_live_e2e_harness_version_token";
const TAG = "[live-e2e-harness-version]";

const log = (msg) => console.log(`${TAG} ${msg}`);
function skipAll(msg) {
  console.error(`${TAG} SKIP: ${msg}`);
  process.exit(2);
}

if (!existsSync(CLI_BIN)) skipAll(`CLI not built (${CLI_BIN}); run pnpm build`);
assertNoRealKeychainToken();

/** First semver-ish token in a `--version` banner (`codex-cli 0.148.0-alpha.9`, `1.0.78.`). */
const VERSION_RE = /\d+\.\d+\.\d+(?:[-+][\w.]*[\w])?/;
/** Same shape rule the adapters apply, so the rig cannot pass a value the wire would reject. */
function sanitizeLikeAdapter(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(trimmed) ? trimmed : undefined;
}

function probeVersion(bin) {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (res.status !== 0) return null;
  return VERSION_RE.exec(`${res.stdout}${res.stderr}`)?.[0] ?? null;
}

// ── stub ingest sink ─────────────────────────────────────────────────────────
const received = [];
const sink = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    try {
      received.push(JSON.parse(raw));
    } catch {
      received.push({ unparseable: raw });
    }
    res.statusCode = 202;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ accepted: true, decision: "notified" }));
  });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
const SINK_URL = `http://127.0.0.1:${sink.address().port}`;
log(`stub sink at ${SINK_URL}`);

// ── sandbox helpers ──────────────────────────────────────────────────────────
const sandboxes = [];
function makeSandbox(name) {
  const root = mkdtempSync(join(tmpdir(), `birdybeep-hv-${name}-`));
  sandboxes.push(root);
  const home = join(root, "home");
  const work = join(root, "work");
  const bin = join(root, "bin");
  for (const d of [home, work, bin]) mkdirSync(d, { recursive: true });
  // The managed config invokes a bare `birdybeep`; the sandbox supplies it as a wrapper
  // around the freshly built CLI, exactly like a global install would.
  // The shim pins BirdyBeep's OWN home, so the queue/token/salt stay in the sandbox even when
  // the harness itself is left running under the real HOME (see `harnessHome` below).
  writeFileSync(
    join(bin, "birdybeep"),
    `#!/bin/sh\nHOME="${home}" XDG_CONFIG_HOME="${join(home, ".config")}" ` +
      `XDG_DATA_HOME="${join(home, ".local", "share")}" XDG_STATE_HOME="${join(home, ".local", "state")}" ` +
      `exec "${process.execPath}" "${CLI_BIN}" "$@"\n`,
  );
  chmodSync(join(bin, "birdybeep"), 0o755);
  return { root, home, work, bin };
}

/**
 * Env vars that name the harness a process is running INSIDE. This script is routinely run from
 * inside one of the very harnesses it tests, so they must not survive into a sandbox: an
 * inherited `AI_AGENT` / `CLAUDE_CODE_EXECPATH` would be read as the launched engine's identity
 * and make every assertion vacuous.
 */
const HARNESS_IDENTITY_ENV_RE = /^(AI_AGENT|CLAUDE|CODEX|COPILOT|CURSOR|OPENCODE|BIRDYBEEP)/;

/** The ambient env minus anything that names a harness, re-homed into the sandbox. */
function sandboxEnv(sb, extra = {}, { realHome = false } = {}) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !HARNESS_IDENTITY_ENV_RE.test(k)),
  );
  const home = realHome ? (process.env.HOME ?? sb.home) : sb.home;
  return {
    ...base,
    // The sandbox wrapper wins; the rest of PATH is inherited so the harness still finds git/node.
    PATH: `${sb.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    BIRDYBEEP_API_URL: SINK_URL,
    ...extra,
  };
}

function birdybeep(sb, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: sb.work,
    env: sandboxEnv(sb, extraEnv),
    encoding: "utf8",
  });
}

/**
 * Seed a throwaway machine token into the sandbox's strict-perm FILE store.
 *
 * Explicitly NOT the OS keychain: the keychain is per-USER, not per-HOME, so writing there would
 * escape the sandbox (and prompt). Reading is safe in the other direction only while the keychain
 * holds no real BirdyBeep token — `getToken` tries it first — so {@link assertNoRealKeychainToken}
 * refuses to run this rig on a paired machine rather than risk pointing a real token at the stub.
 */
function seedToken(sb) {
  const res = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { setToken, unavailableKeychainBackend } = await import(${JSON.stringify(pathToFileURL(AGENT_CORE_DIST).href)});
       await setToken(${JSON.stringify(TOKEN)}, { backend: unavailableKeychainBackend });`,
    ],
    { env: sandboxEnv(sb), encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`token seed failed: ${(res.stderr ?? "").trim()}`);
}

/** Refuse to run if this machine holds a REAL machine token the hook could pick up instead. */
function assertNoRealKeychainToken() {
  if (process.platform !== "darwin") return;
  const res = spawnSync("security", ["find-generic-password", "-s", "birdybeep"], {
    encoding: "utf8",
  });
  if (res.status === 0) {
    skipAll(
      "this machine has a real BirdyBeep token in the OS keychain; the hook would send THAT to " +
        "the stub sink. Run `birdybeep logout` (or run this on an unpaired machine) first.",
    );
  }
}

/**
 * Spawn the harness and wait for its hooks to deliver — NOT for the process to exit.
 *
 * Lifecycle hooks fire within seconds of session start, but an unauthenticated harness can sit in
 * a long transport-retry loop (or block on an interactive prompt) long after it has told us
 * everything we need. So this returns as soon as the sink has been quiet for a beat with at least
 * one event in hand, and kills the child either way. Async spawn, so the in-process sink stays
 * responsive while the hooks fire.
 */
async function runHarness(bin, args, sb, extraEnv = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const child = spawn(bin, args, {
    cwd: sb.work,
    env: sandboxEnv(sb, extraEnv, { realHome: opts.realHome === true }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  let closed = false;
  void once(child, "close").then(() => (closed = true));

  const deadline = Date.now() + timeoutMs;
  let quietSince = 0;
  let seen = received.length;
  while (Date.now() < deadline && !closed) {
    await new Promise((r) => setTimeout(r, 700));
    if (received.length !== seen) {
      seen = received.length;
      quietSince = Date.now();
    } else if (seen > 0 && quietSince > 0 && Date.now() - quietSince > 3000) {
      break; // events arrived and stopped — the harness has said all it is going to say
    }
  }
  if (!closed) {
    child.kill("SIGKILL");
    await once(child, "close").catch(() => {});
  }
  return { stdout: out, stderr: err };
}

/** Wait for the sink to go quiet — hooks are fire-and-forget children of the harness. */
async function settle(ms = 6000) {
  let seen = -1;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (received.length === seen && received.length > 0) return;
    seen = received.length;
    await new Promise((r) => setTimeout(r, 700));
  }
}

// ── Codex trust import (see the header) ──────────────────────────────────────
function trustedCodexConfig() {
  const candidates = [
    process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "config.toml") : null,
    join(homedir(), ".codex", "config.toml"),
  ].filter(Boolean);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    if (raw.includes("[hooks.state") && raw.includes("trusted_hash")) return { path, raw };
  }
  return null;
}

// ── the legs ─────────────────────────────────────────────────────────────────
function desktopClaudeEngines() {
  const root = join(homedir(), "Library", "Application Support", "Claude", "claude-code");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((v) => join(root, v, "claude.app", "Contents", "MacOS", "claude"))
    .filter((p) => existsSync(p));
}

function whichOnPath(command) {
  const res = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

const claudeTerminal = whichOnPath("claude");
const claudeDesktop = desktopClaudeEngines().pop() ?? null;
const codexTerminal = whichOnPath("codex");
const codexChatGpt = "/Applications/ChatGPT.app/Contents/Resources/codex";
const copilotBin = whichOnPath("copilot");

const legs = [];

for (const [label, bin] of [
  ["claude-code terminal CLI", claudeTerminal],
  ["claude-code desktop-bundled engine", claudeDesktop],
]) {
  if (!bin) continue;
  legs.push({
    label,
    bin,
    harness: "claude_code",
    async run() {
      const sb = makeSandbox("claude");
      seedToken(sb);
      const install = birdybeep(sb, ["agent", "install", "claude"]);
      if (install.status !== 0) throw new Error(`install failed: ${install.stderr}`);
      await runHarness(bin, ["-p", "reply with exactly: OK", "--output-format", "text"], sb, {
        // Keep the harness away from the network/model entirely: lifecycle hooks still fire.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      });
    },
  });
}

for (const [label, bin] of [
  ["codex terminal CLI", codexTerminal],
  ["codex bundled in ChatGPT.app", existsSync(codexChatGpt) ? codexChatGpt : null],
]) {
  if (!bin) continue;
  legs.push({
    label,
    bin,
    harness: "codex",
    async run() {
      // Codex will not run an untrusted `[[hooks.X]]` command, and trust is granted only through
      // its interactive /hooks dialog — there is no supported way to synthesise it (its
      // `trusted_hash` does not survive the hook tables being rewritten, and an untrusted hook is
      // skipped SILENTLY: no dialog, no error, no fire). So this leg needs a THROWAWAY Codex
      // profile that a human has already trusted BirdyBeep's hooks in, used in place:
      //
      //   1. CODEX_HOME=/tmp/bb-codex codex   (a fresh profile; leave it running)
      //   2. birdybeep agent install codex    (with the same CODEX_HOME)
      //   3. in Codex: /hooks → Trust all
      //   4. BIRDYBEEP_HV_CODEX_HOME=/tmp/bb-codex node scripts/live-e2e-harness-version.mjs
      //
      // Nothing is written to it here beyond the session rollout Codex itself records.
      const codexHome = process.env.BIRDYBEEP_HV_CODEX_HOME;
      if (!codexHome) return "skip: set BIRDYBEEP_HV_CODEX_HOME to a trusted throwaway profile";
      if (codexHome === join(homedir(), ".codex")) {
        return "skip: BIRDYBEEP_HV_CODEX_HOME must not be the real ~/.codex";
      }
      const configPath = join(codexHome, "config.toml");
      const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
      if (!config.includes("birdybeep hook codex") || !config.includes("trusted_hash")) {
        return "skip: that Codex profile has no TRUSTED BirdyBeep hook entries yet";
      }
      const sb = makeSandbox("codex");
      seedToken(sb);
      const run = await runHarness(
        bin,
        ["exec", "--skip-git-repo-check", "reply with exactly: OK"],
        sb,
        { CODEX_HOME: codexHome },
        // Codex authenticates out of the real profile; only its CONFIG is sandboxed (CODEX_HOME),
        // and the birdybeep shim still pins BirdyBeep's own state to the sandbox. The long
        // window is for an unauthenticated profile: Codex retries its transport for minutes
        // before it opens the session that fires SessionStart.
        { realHome: true, timeoutMs: 420_000 },
      );
      lastRunLog = `${run.stdout}\n${run.stderr}`.slice(-1200);
      return null;
    },
  });
}

if (copilotBin) {
  legs.push({
    label: "GitHub Copilot CLI",
    bin: copilotBin,
    harness: "copilot",
    // Copilot CLI updates its JS payload in place, so `copilot --version` reports the BUNDLE
    // version while the running process exports the NATIVE BINARY version it was launched as
    // (observed 2026-08-18: `--version` 1.0.80, `COPILOT_CLI_BINARY_VERSION` 1.0.78 — the brew
    // cask on disk was 1.0.70). The binary version is the one that identifies the process that
    // fired the hook, which is what this field is for, so `--version` is not the oracle here:
    // assert instead that every event carries the SAME version-shaped value.
    oracle: "self-consistent",
    async run() {
      const sb = makeSandbox("copilot");
      const copilotHome = join(sb.home, ".copilot");
      mkdirSync(copilotHome, { recursive: true });
      seedToken(sb);
      const install = birdybeep(sb, ["agent", "install", "copilot"], { COPILOT_HOME: copilotHome });
      if (install.status !== 0) throw new Error(`install failed: ${install.stderr}`);
      await runHarness(
        copilotBin,
        ["-p", "reply with exactly: OK", "--allow-all-tools"],
        sb,
        { COPILOT_HOME: copilotHome },
        // Copilot authenticates out of the real profile; only its hooks dir is sandboxed.
        { realHome: true },
      );
    },
  });
}

// ── drive every leg ──────────────────────────────────────────────────────────
const ONLY = process.env.BIRDYBEEP_HV_ONLY ?? "";
let lastRunLog = "";
let ran = 0;
let failed = 0;
const summary = [];

try {
  for (const leg of legs) {
    if (ONLY && !leg.label.toLowerCase().includes(ONLY.toLowerCase())) continue;
    lastRunLog = "";
    const expected = probeVersion(leg.bin);
    if (expected === null) {
      summary.push(`SKIP  ${leg.label} — \`--version\` did not report one`);
      continue;
    }
    received.length = 0;
    log(`--- ${leg.label} (${leg.bin}) expects harness_version ${expected}`);
    let skipReason = null;
    try {
      skipReason = await leg.run();
    } catch (err) {
      failed += 1;
      summary.push(`FAIL  ${leg.label} — ${err.message}`);
      continue;
    }
    if (skipReason) {
      summary.push(`SKIP  ${leg.label} — ${skipReason.replace(/^skip: /, "")}`);
      continue;
    }
    await settle(3000);
    const events = received.filter((e) => e && e.harness === leg.harness);
    ran += 1;
    if (events.length === 0) {
      failed += 1;
      summary.push(
        `FAIL  ${leg.label} — no ${leg.harness} events reached the sink` +
          (lastRunLog ? `\n        last harness output: ${lastRunLog}` : ""),
      );
      continue;
    }
    if (leg.oracle === "self-consistent") {
      const values = [...new Set(events.map((e) => e.harness_version))];
      const bad = values.filter((v) => sanitizeLikeAdapter(v) === undefined);
      if (values.length !== 1 || bad.length > 0) {
        failed += 1;
        summary.push(
          `FAIL  ${leg.label} — events disagreed or reported a non-version: ${values.join(", ")}`,
        );
        continue;
      }
      for (const e of events) log(`      ${e.event_type} harness_version=${e.harness_version}`);
      if (process.env.BIRDYBEEP_HV_DUMP) log(`      payload: ${JSON.stringify(events[0])}`);
      summary.push(
        `PASS  ${leg.label} — ${events.length} event(s), all harness_version ${values[0]} ` +
          `(\`--version\` reports the bundle number ${expected})`,
      );
      continue;
    }
    const wrong = events.filter((e) => e.harness_version !== expected);
    if (wrong.length > 0) {
      failed += 1;
      const got = [...new Set(wrong.map((e) => String(e.harness_version)))].join(", ");
      summary.push(
        `FAIL  ${leg.label} — ${wrong.length}/${events.length} events reported ${got}, expected ${expected}`,
      );
      continue;
    }
    for (const e of events) {
      log(`      ${e.event_type} harness_version=${e.harness_version}`);
    }
    if (process.env.BIRDYBEEP_HV_DUMP) log(`      payload: ${JSON.stringify(events[0])}`);
    summary.push(`PASS  ${leg.label} — ${events.length} event(s), all harness_version ${expected}`);
  }
} finally {
  sink.close();
  if (process.env.BIRDYBEEP_E2E_KEEP) {
    log(`BIRDYBEEP_E2E_KEEP set — leaving sandboxes: ${sandboxes.join(" ")}`);
  } else {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${TAG} results`);
for (const line of summary) console.log(`${TAG}   ${line}`);

if (failed > 0) process.exit(1);
if (ran === 0) skipAll("no harness leg was runnable on this machine");
log(`all ${ran} runnable leg(s) passed`);
