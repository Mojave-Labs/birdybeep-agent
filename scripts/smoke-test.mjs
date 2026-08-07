#!/usr/bin/env node
/**
 * Consumer-install smoke test (§16.3, REL-SMOKE).
 *
 * Default mode builds and packs every public workspace package, then installs the
 * tarballs globally into an isolated prefix. Registry mode installs the real package
 * exactly as a user does; `--published` is the post-release npmjs shorthand.
 *
 *   pnpm smoke
 *   pnpm smoke -- --registry http://127.0.0.1:4873
 *   pnpm smoke -- --published
 *   node scripts/smoke-test.mjs --package-spec /tmp/broken.tgz --skip-build
 *
 * Every mode uses a fresh HOME, XDG dirs, npm cache/config, and global prefix. The CLI
 * runs with a deliberately minimal PATH that contains Node but not macOS `security`, so
 * an existing login-keychain token can never make the supposedly-unpaired smoke pass.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const PACKAGES = ["agent-core", "claude-code", "codex", "cursor", "copilot", "opencode", "cli"];
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

if (process.argv.includes("--help")) {
  console.log(`Usage: node scripts/smoke-test.mjs [options]

Options:
  --published             install the repo's exact CLI version from npmjs
  --registry <url>        install @birdybeep/cli from this registry
  --package-spec <spec>   install an explicit npm spec or tarball
  --expected-version <v>  require the installed CLI to match this version
  --skip-build            skip the local-mode workspace build
  --help                  show this help`);
  process.exit(0);
}

const published = process.argv.includes("--published");
const registry = argumentValue("--registry") ?? DEFAULT_REGISTRY;
const explicitSpec = argumentValue("--package-spec");
const localCliVersion = JSON.parse(
  readFileSync(join(ROOT, "packages", "cli", "package.json"), "utf8"),
).version;
const expectedVersion =
  argumentValue("--expected-version") ?? (published ? localCliVersion : undefined);
const skipBuild = process.argv.includes("--skip-build");
const externalMode = published || process.argv.includes("--registry") || explicitSpec !== undefined;
const packageSpec =
  explicitSpec ?? (published ? `@birdybeep/cli@${expectedVersion}` : "@birdybeep/cli");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });

function scrubSecrets(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH)/i.test(key)) delete clean[key];
  }
  return clean;
}

function parseJsonOutput(result, commandName) {
  const lines = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Keep looking: npm/platform warnings may precede the JSON line.
    }
  }
  throw new Error(`${commandName} produced no JSON report (exit ${String(result.status)})`);
}

function assertExit(result, expected, commandName) {
  if (result.error) throw result.error;
  if (!expected.includes(result.status)) {
    throw new Error(
      `${commandName} exited ${String(result.status)} (expected ${expected.join(" or ")}): ${result.stderr.trim()}`,
    );
  }
}

const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-smoke-"));
const home = join(sandbox, "home");
const prefix = join(sandbox, "prefix");
const npmCache = join(sandbox, "npm-cache");
const npmrc = join(sandbox, "npmrc");
const tarDir = join(sandbox, "tarballs");
for (const dir of [home, prefix, npmCache, tarDir]) mkdirSync(dir, { recursive: true });
writeFileSync(npmrc, `registry=${registry.replace(/\/$/, "")}/\n`, { mode: 0o600 });

const isolatedBase = {
  ...scrubSecrets(process.env),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  TMPDIR: join(sandbox, "tmp"),
  TEMP: join(sandbox, "tmp"),
  TMP: join(sandbox, "tmp"),
  NPM_CONFIG_CACHE: npmCache,
  npm_config_cache: npmCache,
  NPM_CONFIG_USERCONFIG: npmrc,
  npm_config_userconfig: npmrc,
  NO_UPDATE_NOTIFIER: "1",
};
mkdirSync(isolatedBase.TMPDIR, { recursive: true });

// Keep Node for the bin shebang, but intentionally hide `security` and all harness CLIs.
const cliEnv = {
  ...isolatedBase,
  PATH: dirname(process.execPath),
  BIRDYBEEP_API_URL: "http://127.0.0.1:1",
};

let failed = false;
try {
  const installSpecs = [];
  if (externalMode) {
    console.log(`▶ smoke: registry consumer mode (${packageSpec}, ${registry})`);
    installSpecs.push(packageSpec);
  } else {
    console.log(`▶ smoke: local published-shape mode (all ${PACKAGES.length} public packages)`);
    if (!skipBuild) {
      console.log("▶ building all packages…");
      run("pnpm", ["turbo", "build"], { cwd: ROOT, stdio: "inherit" });
    }
    console.log(`▶ packing all ${PACKAGES.length} public packages…`);
    for (const pkg of PACKAGES) {
      run("pnpm", ["pack", "--pack-destination", tarDir], {
        cwd: join(ROOT, "packages", pkg),
      });
    }
    const tarballs = readdirSync(tarDir)
      .filter((entry) => entry.endsWith(".tgz"))
      .map((entry) => resolve(tarDir, entry));
    if (tarballs.length !== PACKAGES.length) {
      throw new Error(`expected ${PACKAGES.length} tarballs, got ${tarballs.length}`);
    }
    installSpecs.push(...tarballs);
  }

  console.log(`▶ installing globally into isolated prefix ${prefix}…`);
  run(
    "npm",
    [
      "install",
      "-g",
      "--no-fund",
      "--no-audit",
      "--prefix",
      prefix,
      "--registry",
      registry,
      ...installSpecs,
    ],
    { cwd: sandbox, env: isolatedBase, stdio: "inherit" },
  );

  const bin =
    process.platform === "win32" ? join(prefix, "birdybeep.cmd") : join(prefix, "bin", "birdybeep");
  if (!existsSync(bin)) throw new Error(`installed binary is missing: ${bin}`);

  const npmRoot = run("npm", ["root", "-g", "--prefix", prefix], {
    env: isolatedBase,
  }).trim();
  const installedManifest = JSON.parse(
    readFileSync(join(npmRoot, "@birdybeep", "cli", "package.json"), "utf8"),
  );
  if (expectedVersion !== undefined && installedManifest.version !== expectedVersion) {
    throw new Error(
      `installed @birdybeep/cli@${installedManifest.version}; expected ${expectedVersion}`,
    );
  }

  const runCli = (args) =>
    spawnSync(bin, args, {
      cwd: sandbox,
      env: cliEnv,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

  console.log("▶ exercising the installed CLI in the clean HOME…");
  const version = runCli(["--version"]);
  assertExit(version, [0], "birdybeep --version");
  if (version.stdout.trim() !== installedManifest.version) {
    throw new Error(
      `--version reported ${JSON.stringify(version.stdout.trim())}; installed manifest is ${installedManifest.version}`,
    );
  }
  console.log(`   birdybeep --version → ${installedManifest.version}  ✓`);

  const help = runCli(["--help"]);
  assertExit(help, [0], "birdybeep --help");
  for (const command of ["pair", "logout", "unpair", "status", "test", "doctor", "agent", "hook"]) {
    if (!help.stdout.includes(command)) throw new Error(`--help is missing command: ${command}`);
  }
  console.log("   birdybeep --help lists the full command surface  ✓");

  const status = runCli(["status", "--json"]);
  assertExit(status, [1], "birdybeep status --json (unpaired)");
  const statusReport = parseJsonOutput(status, "birdybeep status --json");
  if (statusReport.paired !== false)
    throw new Error("clean-HOME status did not report paired:false");
  console.log("   birdybeep status handles the unpaired state  ✓");

  const doctor = runCli(["doctor", "--json"]);
  assertExit(doctor, [0, 1], "birdybeep doctor --json");
  const doctorReport = parseJsonOutput(doctor, "birdybeep doctor --json");
  const tokenCheck = doctorReport.checks?.find((check) => check.name === "Machine token");
  if (tokenCheck?.ok !== false || !/No machine token/.test(tokenCheck.detail ?? "")) {
    throw new Error("clean-HOME doctor did not diagnose the missing machine token");
  }
  console.log("   birdybeep doctor runs and diagnoses the clean unpaired environment  ✓");

  const tokenPath = join(isolatedBase.XDG_DATA_HOME, "birdybeep", "token");
  if (existsSync(tokenPath)) throw new Error(`smoke unexpectedly wrote a token: ${tokenPath}`);
  console.log("   no machine token was required or written  ✓");
} catch (error) {
  console.error(`✗ smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  failed = true;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("\n✓ smoke passed: the CLI installed and ran as a clean, unpaired consumer.");
