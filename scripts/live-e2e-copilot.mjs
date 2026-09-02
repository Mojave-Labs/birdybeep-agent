#!/usr/bin/env node
/**
 * Real GitHub Copilot CLI → installed BirdyBeep hook → `wrangler dev` → D1/Queue → Expo-wire
 * verification. By default, no GitHub token and no paid model are used: Copilot runs against a
 * loopback OpenAI-compatible provider with every GitHub credential absent. Set
 * BIRDYBEEP_COPILOT_AUTH_MODE=github to exercise GitHub-hosted Copilot using an existing macOS
 * Keychain login. The backend uses throwaway local state, stub Resend, and stub Expo, but
 * the Worker, auth, pairing, ingestion, D1, and Queue consumer are all real.
 *
 * Run after `pnpm build`:
 *   BIRDYBEEP_PRODUCT_REPO=/path/to/birdybeep node scripts/live-e2e-copilot.mjs
 *   BIRDYBEEP_COPILOT_AUTH_MODE=github BIRDYBEEP_PRODUCT_REPO=/path/to/birdybeep \
 *     node scripts/live-e2e-copilot.mjs
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  accessSync,
  chmodSync,
  constants,
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
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_BIN = join(REPO, "packages", "cli", "dist", "bin.js");
const CORE_DIST = join(REPO, "packages", "agent-core", "dist", "index.js");
const PRODUCT_REPO = process.env.BIRDYBEEP_PRODUCT_REPO
  ? resolve(process.env.BIRDYBEEP_PRODUCT_REPO)
  : resolve(REPO, "../birdybeep");
const API_DIR = join(PRODUCT_REPO, "apps", "api");
const PORT = Number(process.env.PORT ?? 8807);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH_MODE = process.env.BIRDYBEEP_COPILOT_AUTH_MODE ?? "byok";
const REAL_HOME = process.env.HOME ?? process.env.USERPROFILE;

const PRIVATE_COMMAND = "PRIVATE COPILOT COMMAND E2E 8b4c";
const PRIVATE_PROMPT =
  AUTH_MODE === "github"
    ? `Use the bash tool to run exactly this harmless command, then reply with a brief confirmation: printf '${PRIVATE_COMMAND}\\n'`
    : "PRIVATE COPILOT PROMPT E2E 7f3a";
// Tool hooks are intentionally `local_only` in the mirrored notify matrix: they prove the
// installed hook is live through the bounded local tally, but must never spend an HTTP request or
// appear in D1. Keep the two expectations separate so this live gate protects both halves.
const EXPECTED_SERVER_EVENTS = [
  "session_started",
  "session_active",
  "agent_completed",
  "session_ended",
];
const EXPECTED_LOCAL_EVENTS = ["tool_started", "tool_finished"];

const log = (message) => console.log(`[live-e2e-copilot] ${message}`);
function fail(message) {
  throw new Error(message);
}
function assert(condition, message) {
  if (!condition) fail(message);
}
assert(
  AUTH_MODE === "byok" || AUTH_MODE === "github",
  "BIRDYBEEP_COPILOT_AUTH_MODE must be either 'byok' or 'github'",
);
if (AUTH_MODE === "github") {
  assert(process.platform === "darwin", "GitHub auth mode currently requires macOS Keychain");
  assert(REAL_HOME, "GitHub auth mode requires HOME or USERPROFILE");
}
function findExecutable(name) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}

if (!existsSync(CLI_BIN) || !existsSync(CORE_DIST)) {
  console.error("live-e2e-copilot: built CLI/core missing; run `pnpm build` first");
  process.exit(2);
}
if (!existsSync(join(API_DIR, ".dev.vars"))) {
  console.error(
    `live-e2e-copilot: ${join(API_DIR, ".dev.vars")} missing; set BIRDYBEEP_PRODUCT_REPO to a configured product checkout`,
  );
  process.exit(2);
}
const copilotBin = findExecutable("copilot");
if (copilotBin === null) {
  console.error("live-e2e-copilot: `copilot` is not on PATH");
  process.exit(2);
}
const copilotVersion = spawnSync(copilotBin, ["--version"], { encoding: "utf8" });
if (copilotVersion.status !== 0) {
  console.error("live-e2e-copilot: `copilot --version` failed");
  process.exit(2);
}
log(copilotVersion.stdout.trim());

const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-live-copilot-"));
const stateDir = mkdtempSync(join(tmpdir(), "birdybeep-copilot-worker-"));
const home = join(sandbox, "home");
const work = join(sandbox, "work");
const bin = join(sandbox, "bin");
const copilotHome = join(home, ".copilot");
const wranglerLog = join(stateDir, "wrangler.log");
const filteredActivityPath = join(
  process.platform === "win32"
    ? join(home, "AppData", "Local")
    : process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : join(home, ".local", "share"),
  "birdybeep",
  "filtered-events.json",
);
for (const directory of [home, work, bin, copilotHome]) mkdirSync(directory, { recursive: true });

if (AUTH_MODE === "github") {
  // Copilot 1.0.78 shells out to macOS `security`. Expose a least-privilege shim that permits only
  // reads of Copilot's own service. BirdyBeep's hook inherits this PATH, but attempts to read its
  // real user Keychain service are denied and therefore fall back to the seeded sandbox file.
  const securityShim = join(bin, "security");
  writeFileSync(
    securityShim,
    `#!/bin/sh
if [ "$1" != "find-generic-password" ]; then exit 44; fi
previous=""
for argument in "$@"; do
  if [ "$previous" = "-s" ] && [ "$argument" = "copilot-cli" ]; then
    exec /usr/bin/security "$@"
  fi
  previous="$argument"
done
exit 44
`,
  );
  chmodSync(securityShim, 0o700);
}

// Use an absolute Node path and a PATH without /usr/bin so hook token reads cannot consult the
// user's real macOS Keychain. They must fall back to the token file inside the temporary HOME.
writeFileSync(
  join(bin, "birdybeep"),
  `#!/bin/sh
export HOME="${home}"
export USERPROFILE="${home}"
exec "${process.execPath}" "${CLI_BIN}" "$@"
`,
);
chmodSync(join(bin, "birdybeep"), 0o755);
const hookPath = [bin, dirname(copilotBin), dirname(process.execPath), "/bin"].join(delimiter);

const otpByEmail = new Map();
const expoSends = [];
function startStubResend() {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(raw);
        const otp = /\b(\d{6})\b/.exec(body.text ?? "")?.[1];
        if (body.to && otp) otpByEmail.set(body.to, otp);
      } catch {
        // A malformed stub request will be caught by the sign-in timeout.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "stub-email" }));
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}
function startStubExpo() {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      let messages = [];
      try {
        messages = JSON.parse(raw);
        if (Array.isArray(messages)) expoSends.push(...messages);
      } catch {
        messages = [];
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: (Array.isArray(messages) ? messages : []).map((_, index) => ({
            status: "ok",
            id: `copilot-receipt-${index}`,
          })),
        }),
      );
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

let providerCalls = 0;
function startModelProvider() {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      let input = {};
      try {
        input = JSON.parse(raw);
      } catch {
        // The failure below will make the real Copilot run fail visibly.
      }
      providerCalls += 1;
      const toolAlreadyRan = Array.isArray(input.messages)
        ? input.messages.some((message) => message.role === "tool")
        : false;
      const message = toolAlreadyRan
        ? { role: "assistant", content: "Copilot live hook verification complete." }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_birdybeep_copilot_live",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: `printf '${PRIVATE_COMMAND}\\n'`,
                    description: "Emit a harmless private verification marker",
                  }),
                },
              },
            ],
          };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `chatcmpl-copilot-live-${providerCalls}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: input.model ?? "gpt-4.1",
          choices: [
            {
              index: 0,
              message,
              finish_reason: toolAlreadyRan ? "stop" : "tool_calls",
            },
          ],
          usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 },
        }),
      );
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

function migrate() {
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir],
    { cwd: API_DIR, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
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
      stateDir,
      "--var",
      "RESEND_API_KEY:re_copilot_rig_stub",
      "--var",
      "EMAIL_FROM:birdybeep <login@birdybeep.test>",
      "--var",
      `RESEND_API_URL:${resendUrl}`,
      "--var",
      `EXPO_PUSH_URL:${expoUrl}`,
      // Deterministic throwaway secrets for this ephemeral local Worker. These override any
      // stale local .dev.vars values and are never used outside the discarded state directory.
      "--var",
      "BETTER_AUTH_SECRET:copilot-e2e-better-auth-secret-6f3a2c91d8e74b50",
      "--var",
      `BETTER_AUTH_URL:${BASE}`,
      "--var",
      "MACHINE_TOKEN_PEPPER:copilot-e2e-machine-pepper-87ac54f932d10be6",
      "--var",
      "DB_ENCRYPTION_KEK:eHJlcG8tZTJlLWtlay0wMTIzNDU2Nzg5YWJjZGVmMDE=",
    ],
    {
      cwd: API_DIR,
      stdio: ["ignore", openSync(wranglerLog, "a"), openSync(wranglerLog, "a")],
      detached: true,
    },
  );
}
function stopWrangler(child) {
  try {
    if (child?.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  try {
    child?.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}
async function waitForHealth(timeoutMs = 90_000) {
  const started = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch {
      // Still starting.
    }
    if (Date.now() - started > timeoutMs) fail("wrangler dev never became healthy");
    await sleep(500);
  }
}
async function api(method, path, { body, token } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Preserve raw error text.
  }
  return { status: response.status, headers: response.headers, body: parsed };
}
async function signIn(email) {
  const sent = await api("POST", "/api/auth/email-otp/send-verification-otp", {
    body: { email, type: "sign-in" },
  });
  assert(sent.status === 200, `OTP send failed: ${sent.status}`);
  const started = Date.now();
  let otp;
  while (!(otp = otpByEmail.get(email))) {
    if (Date.now() - started > 20_000) fail("OTP never reached the loopback Resend stub");
    await sleep(200);
  }
  const signed = await api("POST", "/api/auth/sign-in/email-otp", {
    body: { email, otp },
  });
  const token = signed.headers.get("set-auth-token") ?? signed.body?.token;
  assert(typeof token === "string" && token.length > 0, `OTP sign-in failed: ${signed.status}`);
  return token;
}
async function pairMachine(userToken) {
  const started = await api("POST", "/v1/pair/start", {
    body: { machine_label: "copilot-live-rig", os: "macos", cli_version: "0.2.0" },
  });
  assert(started.status === 200 || started.status === 201, `pair/start failed: ${started.status}`);
  const pairParams = new URLSearchParams(new URL(started.body.qr_payload).hash.slice(1));
  const approvalSecret = pairParams.get("s");
  assert(
    typeof approvalSecret === "string" && approvalSecret.length > 0,
    "QR approval secret missing",
  );
  const approved = await api("POST", "/v1/pair/approve", {
    token: userToken,
    body: { user_code: started.body.user_code, approval_secret: approvalSecret },
  });
  assert(approved.body?.approved === true, `pair/approve failed: ${approved.status}`);
  const token = await api("POST", "/v1/pair/token", {
    body: {
      device_code: started.body.device_code,
      machine_fingerprint: `copilot-live-${Date.now()}`,
    },
  });
  assert(typeof token.body?.machine_token === "string", `pair/token failed: ${token.status}`);
  return token.body.machine_token;
}

function baseHookEnv(apiUrl) {
  return {
    PATH: hookPath,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    COPILOT_HOME: copilotHome,
    BIRDYBEEP_API_URL: apiUrl,
  };
}
function birdybeep(args) {
  return spawnSync(process.execPath, [CLI_BIN, ...args, "--json"], {
    cwd: work,
    env: baseHookEnv(BASE),
    encoding: "utf8",
  });
}
async function runCopilot(providerUrl) {
  const modelEnv =
    AUTH_MODE === "github"
      ? {}
      : {
          COPILOT_OFFLINE: "true",
          COPILOT_PROVIDER_BASE_URL: `${providerUrl}/v1`,
          COPILOT_PROVIDER_TYPE: "openai",
          COPILOT_PROVIDER_WIRE_API: "completions",
          COPILOT_MODEL: "gpt-4.1",
        };
  const toolArgs =
    AUTH_MODE === "github"
      ? ["--available-tools=bash", "--allow-tool=shell(printf)", "--no-ask-user"]
      : ["--allow-all-tools"];
  const child = spawn(
    copilotBin,
    [
      "--no-custom-instructions",
      "--disable-builtin-mcps",
      "--no-remote",
      "--no-auto-update",
      "--stream",
      "off",
      ...toolArgs,
      "--silent",
      "-p",
      PRIVATE_PROMPT,
    ],
    {
      cwd: work,
      // Deliberately constructed from scratch: no GH/GITHUB/COPILOT_GITHUB environment token can
      // leak in. GitHub mode relies only on Copilot's existing system credential-store login.
      env: {
        ...baseHookEnv(BASE),
        ...(AUTH_MODE === "github" ? { HOME: REAL_HOME, USERPROFILE: REAL_HOME } : {}),
        ...modelEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const [status] = await once(child, "close");
  clearTimeout(killer);
  return { status, stdout, stderr };
}

let wrangler;
let resend;
let expo;
let provider;
try {
  resend = await startStubResend();
  expo = await startStubExpo();
  if (AUTH_MODE === "byok") provider = await startModelProvider();
  const resendUrl = `http://127.0.0.1:${resend.address().port}`;
  const expoUrl = `http://127.0.0.1:${expo.address().port}/push`;
  const providerUrl = provider ? `http://127.0.0.1:${provider.address().port}` : undefined;

  log("building the real Worker and all of its workspace dependencies");
  execFileSync("pnpm", ["exec", "turbo", "run", "build", "--filter=@birdybeep/api..."], {
    cwd: PRODUCT_REPO,
    stdio: "inherit",
  });
  log("applying all migrations to a throwaway D1");
  migrate();
  wrangler = startWrangler(resendUrl, expoUrl);
  await waitForHealth();
  log(`real wrangler dev healthy at ${BASE}`);

  const userToken = await signIn(`copilot-live-${Date.now()}@birdybeep.test`);
  const machineToken = await pairMachine(userToken);
  assert(machineToken.startsWith("mt_"), "pairing did not return a machine token");
  const device = await api("POST", "/v1/devices/register", {
    token: userToken,
    body: {
      expo_push_token: "ExponentPushToken[copilot-live-rig]",
      platform: "ios",
      device_name: "copilot-live-rig",
    },
  });
  assert(
    device.status === 200 || device.status === 201,
    `device register failed: ${device.status}`,
  );

  const seed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(CORE_DIST).href)}); await m.setToken(process.env.BIRDYBEEP_E2E_MACHINE_TOKEN, { backend: m.unavailableKeychainBackend });`,
    ],
    {
      env: { ...baseHookEnv(BASE), BIRDYBEEP_E2E_MACHINE_TOKEN: machineToken },
      encoding: "utf8",
    },
  );
  assert(seed.status === 0, `file token seed failed: ${seed.stderr}`);

  const installed = birdybeep(["agent", "install", "copilot"]);
  assert(installed.status === 0, `adapter install failed: ${installed.stderr || installed.stdout}`);
  const hooksPath = join(copilotHome, "hooks", "birdybeep.json");
  const hooksRaw = readFileSync(hooksPath, "utf8");
  const hooks = JSON.parse(hooksRaw);
  assert(hooks.version === 1, "Copilot hook file version is not 1");
  assert(
    Object.keys(hooks.hooks ?? {}).join(",") ===
      "sessionStart,userPromptSubmitted,preToolUse,postToolUse,agentStop,subagentStop,errorOccurred,sessionEnd",
    "installed Copilot event set drifted",
  );
  assert(!hooksRaw.includes(machineToken), "machine token leaked into the Copilot hook file");

  log(
    AUTH_MODE === "github"
      ? "running the real GitHub-hosted Copilot CLI using only its system credential-store login"
      : "running the real Copilot CLI with GitHub credentials absent and loopback BYOK",
  );
  const run = await runCopilot(providerUrl);
  assert(run.status === 0, `real Copilot run failed (${run.status}): ${run.stderr.slice(-800)}`);
  if (AUTH_MODE === "byok") {
    assert(
      providerCalls >= 2,
      `loopback provider saw only ${providerCalls} call(s); tool turn did not run`,
    );
  }

  const deadline = Date.now() + 20_000;
  let sessions;
  let detail;
  while (Date.now() < deadline) {
    sessions = await api("GET", "/v1/sessions", { token: userToken });
    const session = sessions.body?.sessions?.find((item) => item.harness === "copilot");
    if (session) {
      detail = await api("GET", `/v1/sessions/${session.id}`, { token: userToken });
      const have = new Set((detail.body?.recent_events ?? []).map((event) => event.event_type));
      if (EXPECTED_SERVER_EVENTS.every((event) => have.has(event)) && expoSends.length > 0) break;
    }
    await sleep(250);
  }
  assert(detail?.status === 200, "Copilot session was not queryable from the real Worker");
  const deliveredTypes = new Set(
    (detail.body?.recent_events ?? []).map((event) => event.event_type),
  );
  for (const expected of EXPECTED_SERVER_EVENTS) {
    assert(deliveredTypes.has(expected), `live backend did not record ${expected}`);
  }
  const filteredActivity = JSON.parse(readFileSync(filteredActivityPath, "utf8"));
  for (const expected of EXPECTED_LOCAL_EVENTS) {
    assert(
      filteredActivity.byType?.[expected] > 0,
      `real Copilot hook did not record local-only ${expected}`,
    );
    assert(
      !deliveredTypes.has(expected),
      `local-only ${expected} reached D1 instead of staying on the machine`,
    );
  }
  assert(detail.body?.harness === "copilot", "live session has the wrong harness");
  assert(detail.body?.status === "completed", `live session ended as ${detail.body?.status}`);
  assert(expoSends.length > 0, "the notified agent_completed event did not traverse the Queue");
  const push = expoSends.find((message) => String(message.title).includes("Copilot"));
  assert(push, "no Copilot push reached the Expo wire stub");

  const downstream = JSON.stringify({
    sessions: sessions.body,
    detail: detail.body,
    pushes: expoSends,
  });
  for (const forbidden of [PRIVATE_PROMPT, PRIVATE_COMMAND, work, home, machineToken]) {
    assert(
      !downstream.includes(forbidden),
      `private value reached downstream output: ${forbidden}`,
    );
  }
  const logs = readFileSync(wranglerLog, "utf8");
  assert(logs.includes("/v1/agent-events"), "wrangler log has no ingestion positive control");
  for (const forbidden of [PRIVATE_PROMPT, PRIVATE_COMMAND, work, home, machineToken]) {
    assert(!logs.includes(forbidden), "private prompt/tool/path/token appeared in Worker logs");
  }

  const uninstalled = birdybeep(["agent", "uninstall", "copilot"]);
  assert(uninstalled.status === 0, `adapter uninstall failed: ${uninstalled.stderr}`);
  assert(!existsSync(hooksPath), "from-scratch uninstall left the managed hook file behind");

  log(
    `PASS — real ${copilotVersion.stdout.trim()} (${AUTH_MODE}) → ${String(EXPECTED_SERVER_EVENTS.length)} server events through wrangler dev D1/Queue → Expo wire; ${String(EXPECTED_LOCAL_EVENTS.length)} tool events proved local-only`,
  );
} finally {
  stopWrangler(wrangler);
  resend?.close();
  expo?.close();
  provider?.close();
  if (process.env.BIRDYBEEP_E2E_KEEP) {
    log(`BIRDYBEEP_E2E_KEEP set; sandbox=${sandbox} worker-state=${stateDir}`);
  } else {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}
