#!/usr/bin/env node
/**
 * Staging contract probe for the checked-in GitHub Actions workflow.
 *
 * Installs all five real adapters into an isolated HOME, seeds a staging-only machine token into
 * the strict-permission file store, and sends one real captured SessionStart-shaped payload per
 * harness through the built CLI. Only non-notifying lifecycle events are used, so the verification
 * exercises authenticated ingest without sending five push notifications to a maintainer.
 *
 * Required in CI: STAGING_API_URL and STAGING_AGENT_TOKEN. Neither value is printed or passed on a
 * command line. `--local-self-test` starts a loopback authenticated sink for pre-secret validation.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const CLI = resolve(ROOT, "packages/cli/dist/bin.js");
const CORE = resolve(ROOT, "packages/agent-core/dist/index.js");
const SELF_TEST = process.argv.includes("--local-self-test");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function cleanEnvironment(source) {
  const result = { ...source };
  for (const key of Object.keys(result)) {
    if (/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH)/i.test(key)) delete result[key];
  }
  return result;
}

function lastJson(stdout, label) {
  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Ignore non-JSON notices and continue toward the first structured result.
    }
  }
  throw new Error(`${label} returned no JSON result`);
}

function checkedSpawn(command, args, options, label) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => {
      if (status === 0) resolvePromise({ status, stdout, stderr });
      else reject(new Error(`${label} exited ${String(status)}: ${stderr.trim().slice(-600)}`));
    });
    child.stdin.end(options.input);
  });
}

function validateApiUrl(value) {
  const parsed = new URL(value);
  invariant(parsed.protocol === "https:" || parsed.hostname === "127.0.0.1", "invalid staging URL");
  invariant(
    parsed.hostname !== "api.birdybeep.com",
    "refusing to run the staging probe against production",
  );
  return value.replace(/\/$/, "");
}

async function runProbe({ apiUrl: rawApiUrl, token }) {
  const apiUrl = validateApiUrl(rawApiUrl);
  invariant(token.length > 0, "STAGING_AGENT_TOKEN is empty");
  invariant(existsSync(CLI) && existsSync(CORE), "build artifacts missing; run `pnpm build` first");

  const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-staging-e2e-"));
  const home = join(sandbox, "home");
  const xdgConfig = join(home, ".config");
  const xdgData = join(home, ".local", "share");
  const localAppData = join(home, "AppData", "Local");
  const appData = join(home, "AppData", "Roaming");
  const workspace = join(sandbox, "workspace");
  const runId = randomUUID();

  const configFiles = [
    join(home, ".claude", "settings.json"),
    join(home, ".codex", "config.toml"),
    join(xdgConfig, "opencode", "opencode.json"),
    join(home, ".cursor", "hooks.json"),
    join(home, ".copilot", "hooks", "birdybeep.json"),
  ];

  const baseEnvironment = {
    ...cleanEnvironment(process.env),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    BIRDYBEEP_API_URL: apiUrl,
    NO_UPDATE_NOTIFIER: "1",
    CI: "1",
    PATH: dirname(process.execPath),
  };

  try {
    for (const directory of [
      join(home, ".claude"),
      join(home, ".codex"),
      join(xdgConfig, "opencode"),
      join(home, ".cursor"),
      join(home, ".copilot"),
      workspace,
    ]) {
      mkdirSync(directory, { recursive: true });
    }

    await checkedSpawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const core = await import(${JSON.stringify(pathToFileURL(CORE).href)}); await core.setToken(process.env.BIRDYBEEP_STAGING_TOKEN_TEMP, { backend: core.unavailableKeychainBackend });`,
      ],
      {
        cwd: ROOT,
        env: { ...baseEnvironment, BIRDYBEEP_STAGING_TOKEN_TEMP: token },
      },
      "token seed",
    );

    const runCli = async (args, input, label) => {
      const result = await checkedSpawn(
        process.execPath,
        [CLI, ...args],
        {
          cwd: ROOT,
          env: baseEnvironment,
          input: input === undefined ? undefined : JSON.stringify(input),
        },
        label,
      );
      invariant(
        !result.stdout.includes(token) && !result.stderr.includes(token),
        `${label} exposed the token`,
      );
      return lastJson(result.stdout, label);
    };

    const install = await runCli(
      ["agent", "install", "all", "--json"],
      undefined,
      "adapter install",
    );
    invariant(install.results?.length === 5, "adapter install did not report all five harnesses");
    invariant(
      install.results.every((item) => item.detected === true),
      "a seeded harness was not detected",
    );

    for (const path of configFiles) {
      invariant(existsSync(path), `managed config was not created: ${path}`);
      invariant(!readFileSync(path, "utf8").includes(token), `machine token leaked into ${path}`);
    }

    const events = [
      {
        harness: "claude_code",
        args: ["hook", "claude", "--json"],
        payload: {
          hook_event_name: "SessionStart",
          session_id: `staging-claude-${runId}`,
          cwd: workspace,
          source: "startup",
        },
      },
      {
        harness: "codex",
        args: ["hook", "codex", "--json"],
        payload: {
          hook_event_name: "SessionStart",
          session_id: `staging-codex-${runId}`,
          cwd: workspace,
          source: "startup",
        },
      },
      {
        harness: "opencode",
        args: ["hook", "opencode", "--json"],
        payload: {
          type: "session.created",
          properties: { info: { id: `staging-opencode-${runId}` } },
          cwd: workspace,
        },
      },
      {
        harness: "cursor",
        args: ["hook", "cursor", "--json"],
        payload: {
          hook_event_name: "sessionStart",
          session_id: `staging-cursor-${runId}`,
          workspace_roots: [workspace],
          cursor_version: "staging-contract-probe",
        },
      },
      {
        harness: "copilot",
        args: ["hook", "copilot", "sessionStart", "--json"],
        payload: {
          sessionId: `staging-copilot-${runId}`,
          cwd: workspace,
          source: "startup",
          initialPrompt: "SENSITIVE_LOCAL_PROBE_PROMPT",
        },
      },
    ];

    for (const event of events) {
      const result = await runCli(event.args, event.payload, `${event.harness} hook`);
      invariant(result.outcome === "delivered", `${event.harness} was not delivered`);
      invariant(result.status === 202, `${event.harness} ingest did not return HTTP 202`);
    }

    await runCli(["agent", "uninstall", "all", "--json"], undefined, "adapter uninstall");
    for (const path of configFiles)
      invariant(!existsSync(path), `uninstall left managed config: ${path}`);

    return { harnesses: events.map((event) => event.harness), workspace };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function localSelfTest() {
  const token = `bbm_TESTONLY_${randomUUID()}`;
  const received = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      invariant(request.url === "/v1/agent-events", "unexpected local self-test path");
      invariant(request.headers.authorization === `Bearer ${token}`, "self-test auth mismatch");
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: true, decision: "suppressed" }));
    })().catch((error) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "self-test failure");
    });
  });

  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  try {
    const address = server.address();
    invariant(address && typeof address === "object", "local self-test server did not start");
    const result = await runProbe({ apiUrl: `http://127.0.0.1:${address.port}`, token });
    invariant(received.length === 5, `local sink received ${received.length}/5 events`);
    invariant(
      JSON.stringify(received.map((event) => event.harness)) === JSON.stringify(result.harnesses),
      "local sink harness order drifted",
    );
    const bodies = JSON.stringify(received);
    invariant(!bodies.includes(token), "token leaked into an event body");
    invariant(!bodies.includes(result.workspace), "raw workspace path leaked into an event body");
    invariant(
      !bodies.includes("SENSITIVE_LOCAL_PROBE_PROMPT"),
      "Copilot prompt leaked into an event body",
    );
    console.log(
      "✓ local staging self-test: 5 isolated installs/hooks delivered; privacy scan clean",
    );
  } finally {
    await new Promise((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }
}

try {
  if (SELF_TEST) {
    await localSelfTest();
  } else {
    const apiUrl = process.env.STAGING_API_URL;
    const token = process.env.STAGING_AGENT_TOKEN;
    invariant(apiUrl, "STAGING_API_URL is required");
    invariant(token, "STAGING_AGENT_TOKEN is required");
    const result = await runProbe({ apiUrl, token });
    console.log(`✓ staging E2E: ${result.harnesses.length} harness SessionStart events accepted`);
  }
} catch (error) {
  console.error(`✗ staging E2E failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
