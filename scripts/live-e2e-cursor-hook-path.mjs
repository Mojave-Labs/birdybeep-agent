#!/usr/bin/env node
/**
 * LIVE end-to-end verification that the command `birdybeep agent install cursor` writes is one
 * Cursor can actually execute (birdybeep-agent-gcgp.9). Unlike `live-e2e-cursor.mjs` this needs no
 * Cursor account and no `cursor-agent` binary — it reproduces Cursor's hook exec context directly,
 * which is where the bug lived.
 *
 * The bug, from Cursor's own hook log:
 *
 *     Command: birdybeep hook claude (830ms) exit code: 127
 *     STDERR:  zsh:1: command not found: birdybeep
 *
 * Cursor runs hooks from its Electron main process (cwd `~/.cursor`), so they inherit the PATH the
 * OS gave the app — not the user's shell PATH. A bare `birdybeep` is not on it. Neither is `node`,
 * so the obvious fix (write the CLI's absolute path) exits 127 too, on the bin's
 * `#!/usr/bin/env node` shebang.
 *
 * What this drives, with the REAL built CLI:
 *   1. hermetic HOME + a real `birdybeep` bin shim (a symlink, the shape npm/pnpm create)
 *   2. the REAL `birdybeep agent install cursor`, invoked through that bin name
 *   3. the command is read STRAIGHT OUT of the written ~/.cursor/hooks.json — never reconstructed
 *   4. it is executed the way Cursor does — /bin/sh, cwd ~/.cursor, PATH stripped to an empty dir —
 *      with a real `beforeMCPExecution` payload on stdin
 *   5. an `approval_required` event must reach a local sink, with the Bearer token, a hashed cwd,
 *      and none of the payload's secrets (MCP access token, tool arguments, user_email)
 *   6. the OLD bare command must still fail 127 in that same environment
 *   7. move the CLI → `birdybeep doctor` must report the stale path → re-install must repair the
 *      entry IN PLACE (not append a second hook) → doctor clean again
 *
 * Requirements: repo built (`pnpm build`). No credentials, no network.
 * Run:  node scripts/live-e2e-cursor-hook-path.mjs
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_BIN = join(REPO, "packages", "cli", "dist", "bin.js");
const AGENT_CORE = join(REPO, "packages", "agent-core", "dist", "index.js");
const TOKEN = "bbm_live_e2e_hook_path_token";

const log = (msg) => console.log(`[live-e2e-hook-path] ${msg}`);
const skip = (msg) => {
  console.error(`[live-e2e-hook-path] SKIP: ${msg}`);
  process.exit(2);
};
let failed = false;
const assert = (cond, msg) => {
  if (cond) {
    log(`ok — ${msg}`);
    return;
  }
  console.error(`[live-e2e-hook-path] FAIL: ${msg}`);
  failed = true;
  throw new Error(msg);
};

if (!existsSync(CLI_BIN)) skip(`CLI not built (${CLI_BIN}) — run pnpm build`);
if (process.platform === "win32") skip("POSIX-only rig (reproduces Cursor's /bin/sh hook exec)");

/**
 * Async spawn. spawnSync would block THIS process's event loop, so the in-process sink could not
 * answer the hook's POST — the sender would time out, queue, and retry, and the rig would see a
 * phantom double delivery that has nothing to do with the code under test.
 */
async function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(opts.input ?? "");
  const [status] = await once(child, "close");
  return { status, stdout, stderr };
}

const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-live-hook-path-"));
const home = join(sandbox, "home");
const binDir = join(sandbox, "bin");
const emptyPath = join(sandbox, "empty-path");
mkdirSync(join(home, ".cursor"), { recursive: true }); // makes detectCursor() report present
mkdirSync(binDir, { recursive: true });
mkdirSync(emptyPath, { recursive: true });

// A real bin shim, exactly the shape npm/pnpm create: a symlink NAMED `birdybeep`. Node keeps the
// invoked path in argv[1], which is what install resolves the launcher from.
const shim = join(binDir, "birdybeep");
symlinkSync(CLI_BIN, shim);

const received = [];
const sink = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    received.push({ path: req.url, headers: req.headers, body: JSON.parse(raw || "{}") });
    res.statusCode = 202;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ accepted: true, decision: "notified" }));
  });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
const sinkUrl = `http://127.0.0.1:${sink.address().port}`;
log(`stub sink listening at ${sinkUrl}`);

/** The USER's environment: the bin shim plus the node the CLI is installed under. */
const userEnv = {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
  BIRDYBEEP_API_URL: sinkUrl,
};
/** CURSOR's environment: same HOME, but a PATH with nothing on it. */
const cursorEnv = { ...userEnv, PATH: emptyPath };

const PAYLOAD = JSON.stringify({
  conversation_id: "00000000-0000-4000-8000-000000000001",
  generation_id: "00000000-0000-4000-8000-000000000001",
  model: "composer-2.5",
  is_background_agent: false,
  session_id: "00000000-0000-4000-8000-000000000001",
  hook_event_name: "beforeMCPExecution",
  cursor_version: "3.15.6",
  workspace_roots: [join(home, "project")],
  user_email: "user@example.com",
  transcript_path: null,
  tool_name: "execute_sql",
  tool_input: '{"query":"select * from users"}',
  mcp_server_name: "supabase",
  command: "npx -y @supabase/mcp-server --access-token sbp_TESTONLY_secret",
});

try {
  // ── 1. seed the machine token into the FILE store (never the real keychain) ─────────────────
  const seed = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { setToken, unavailableKeychainBackend } = await import(${JSON.stringify(
        pathToFileURL(AGENT_CORE).href,
      )});
     console.log(await setToken(${JSON.stringify(TOKEN)}, { backend: unavailableKeychainBackend }));`,
    ],
    { env: userEnv },
  );
  assert(seed.status === 0, `machine token seeded into the ${seed.stdout.trim()} store`);

  // ── 2. REAL install, invoked through the real bin name ─────────────────────────────────────
  const install = await run(shim, ["agent", "install", "cursor"], { env: userEnv });
  assert(install.status === 0, `\`birdybeep agent install cursor\` exited 0${install.stderr}`);

  const hooksPath = join(home, ".cursor", "hooks.json");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  const events = Object.keys(hooks.hooks);
  log(`registered events (${events.length}): ${events.join(", ")}`);
  assert(events.includes("beforeShellExecution"), "the shell approval gate is registered");
  assert(events.includes("beforeMCPExecution"), "the MCP approval gate is registered (gcgp.9)");

  const command = hooks.hooks.beforeMCPExecution[0].command;
  log(`written command: ${command}`);
  assert(command.startsWith('"'), "the written command is an ABSOLUTE launcher, not a bare name");
  assert(command.includes(process.execPath), "…it names the absolute node running the installer");
  assert(command.includes(shim), "…and the absolute CLI entry point it was invoked as");

  // ── 3. execute THAT STRING the way Cursor does ─────────────────────────────────────────────
  const fire = await run("/bin/sh", ["-c", command], {
    cwd: join(home, ".cursor"),
    input: PAYLOAD,
    env: cursorEnv,
  });
  log(`hook exit=${fire.status} stderr=${JSON.stringify(fire.stderr)}`);
  assert(fire.status === 0, "the installed command RUNS under Cursor's PATH (it used to exit 127)");

  await new Promise((r) => setTimeout(r, 250));
  const agentEvents = received.filter((r) => r.path.includes("agent-event"));
  assert(agentEvents.length === 1, `exactly one agent-event reached the sink`);
  const ev = agentEvents[0].body;
  console.log(JSON.stringify(ev, null, 2));
  assert(ev.event_type === "approval_required", "event_type is approval_required");
  assert(ev.status === "waiting_for_approval", "status is waiting_for_approval");
  assert(ev.harness === "cursor", "harness is cursor");
  assert(ev.body === "Approve MCP tool execute_sql?", "the body names the MCP tool");
  assert(ev.metadata.mcp_server === "supabase", "metadata carries the MCP server name");
  assert(/^h_[0-9a-f]{16}$/.test(ev.workspace.cwd), "the workspace root is hashed");
  assert(agentEvents[0].headers.authorization === `Bearer ${TOKEN}`, "the Bearer token rode along");

  const wire = JSON.stringify(agentEvents[0]);
  assert(!wire.includes("sbp_TESTONLY_secret"), "the MCP server's access token was NOT sent");
  assert(!wire.includes("select * from users"), "tool_input was NOT sent");
  assert(!wire.includes("user@example.com"), "user_email was NOT sent");
  assert(!wire.includes(home), "no raw absolute path was sent");

  // ── 4. the pre-fix command, same environment — the bug must still be reproducible ───────────
  const bare = await run("/bin/sh", ["-c", "birdybeep hook cursor"], {
    cwd: join(home, ".cursor"),
    input: PAYLOAD,
    env: cursorEnv,
  });
  log(`bare command exit=${bare.status} stderr=${JSON.stringify(bare.stderr.trim())}`);
  assert(bare.status === 127, "the OLD bare command still reproduces exit 127 here");

  // ── 5. stale path → doctor reports it → install repairs it in place ─────────────────────────
  const moved = `${binDir}-moved`;
  renameSync(binDir, moved);
  const doctor = await run(process.execPath, [CLI_BIN, "doctor"], { env: userEnv });
  const stale = `${doctor.stdout}${doctor.stderr}`
    .split("\n")
    .filter((l) => l.includes("Hook command resolves"));
  log(`doctor says: ${stale.join(" ")}`);
  assert(stale.length > 0, "`birdybeep doctor` reports the stale hook command");

  renameSync(moved, binDir);
  const repair = await run(shim, ["agent", "install", "cursor"], { env: userEnv });
  assert(repair.status === 0, "re-install exited 0");
  const after = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert(
    Object.values(after.hooks).every((entries) => entries.length === 1),
    "the repair rewrote the entry IN PLACE — still exactly one hook per event",
  );
  const doctor2 = await run(process.execPath, [CLI_BIN, "doctor"], { env: userEnv });
  assert(
    !`${doctor2.stdout}${doctor2.stderr}`.includes("Hook command resolves —"),
    "doctor is clean again after the repair",
  );

  log("ALL CHECKS PASSED");
} catch (err) {
  if (!failed) console.error(`[live-e2e-hook-path] FAIL: ${err?.message ?? String(err)}`);
  process.exitCode = 1;
} finally {
  sink.close();
  if (process.env.BIRDYBEEP_E2E_KEEP) log(`BIRDYBEEP_E2E_KEEP set — sandbox kept at ${sandbox}`);
  else rmSync(sandbox, { recursive: true, force: true });
}
