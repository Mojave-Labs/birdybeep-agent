#!/usr/bin/env node
/**
 * Real TLS + built CLI, isolated HOME: trusted roots work; unknown roots and wrong hostnames fail.
 * Linux reads a temporary OS store through SSL_CERT_FILE; Windows installs/removes a generated
 * root in the disposable hosted runner's native store. macOS injects only the store-read boundary
 * so this test never changes the user's Keychain. TLS and the built CLI are real everywhere (3pl).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, "packages/cli/dist/bin.js");
assert.equal(typeof tls.setDefaultCACertificates, "function", "Run with Node 22.19+ or 24.6+");
const sandbox = mkdtempSync(join(tmpdir(), "birdybeep-system-ca-"));
let server;
let removeWindowsRoot;
try {
  const ca = join(sandbox, "ca.pem");
  const caKey = join(sandbox, "ca-key.pem");
  const key = join(sandbox, "server-key.pem");
  const csr = join(sandbox, "server.csr");
  const cert = join(sandbox, "server.pem");
  const extensions = join(sandbox, "extensions.cnf");
  const caConfig = join(sandbox, "ca.cnf");
  writeFileSync(
    caConfig,
    [
      "[req]",
      "distinguished_name=dn",
      "x509_extensions=ca",
      "[dn]",
      "[ca]",
      "basicConstraints=critical,CA:true",
      "keyUsage=critical,keyCertSign,cRLSign",
      "",
    ].join("\n"),
  );
  // Git for Windows supplies OpenSSL outside the default process PATH on hosted runners.
  const windowsOpenSsl =
    process.platform === "win32"
      ? ["mingw64", "usr"]
          .map((dir) =>
            join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", dir, "bin", "openssl.exe"),
          )
          .find(existsSync)
      : undefined;
  const openssl = (args) =>
    execFileSync(windowsOpenSsl ?? "openssl", args, {
      stdio: "ignore",
      timeout: 15000,
    });
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-config",
    caConfig,
    "-subj",
    "/CN=BirdyBeep TLS Test CA",
    "-keyout",
    caKey,
    "-out",
    ca,
  ]);
  openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-config",
    caConfig,
    "-keyout",
    key,
    "-out",
    csr,
  ]);
  writeFileSync(extensions, "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n");
  openssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    extensions,
    "-out",
    cert,
  ]);

  server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert, "utf8") + readFileSync(ca, "utf8") },
    (req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/pair/start") {
        res.end(
          JSON.stringify({
            device_code: "dc_tls_test",
            user_code: "TLS-0001",
            qr_payload: `https://birdybeep.com/pair#code=TLS-0001&s=${"ab".repeat(32)}`,
            expires_at: new Date(Date.now() + 600000).toISOString(),
          }),
        );
      } else if (req.url === "/v1/pair/token") {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            machine_token: `mt_${"ab".repeat(32)}`,
            machine_id: "tls_machine",
            approved_by_email: "tls@birdybeep.test",
          }),
        );
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `https://localhost:${server.address().port}`;
  const storeShim = join(sandbox, "system-store.mjs");
  writeFileSync(
    storeShim,
    `
    import tls from 'node:tls';
    import { readFileSync } from 'node:fs';
    const original = tls.getCACertificates;
    tls.getCACertificates = (type) => type === 'system'
      ? [readFileSync(${JSON.stringify(ca)}, 'utf8')] : original(type);
  `,
  );
  const emptyStore = join(sandbox, "empty-store");
  mkdirSync(emptyStore);

  async function run(name, args, trust = "none", url = baseUrl) {
    const home = join(sandbox, name);
    mkdirSync(home);
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/(TOKEN|SECRET|PASSWORD|API_KEY|AUTH)/i.test(name)) delete env[name];
    }
    for (const name of [
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
      "NODE_USE_SYSTEM_CA",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "CODEX_HOME",
      "NODE_USE_ENV_PROXY",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
    ])
      delete env[name];
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      PATH: dirname(process.execPath),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      BIRDYBEEP_API_URL: url,
      NO_UPDATE_NOTIFIER: "1",
    });
    const preloads = [];
    if (trust === "system") {
      if (process.platform === "linux") {
        env.SSL_CERT_FILE = ca;
        env.SSL_CERT_DIR = emptyStore;
      } else if (process.platform !== "win32") {
        preloads.push("--import", pathToFileURL(storeShim).href);
      }
    } else if (trust === "extra") {
      env.NODE_EXTRA_CA_CERTS = ca;
    }
    const child = spawn(process.execPath, [...preloads, cli, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    }).finally(() => clearTimeout(timer));
    assert.notEqual(code, null, `${name} timed out`);
    assert.ok(!`${stdout}${stderr}`.includes(`mt_${"ab".repeat(32)}`), "token must not be printed");
    return { code, stdout, stderr };
  }
  const setupArgs = [
    "setup",
    "--expect-email",
    "tls@birdybeep.test",
    "--no-install",
    "--no-test",
    "--json",
    "--non-interactive",
  ];
  const network = (stdout) =>
    JSON.parse(stdout).checks.find((check) => check.name === "Backend reachable");

  const rejected = await run("untrusted-doctor", ["doctor", "--json"]);
  assert.equal(rejected.code, 1);
  assert.equal(network(rejected.stdout).ok, false);
  assert.match(network(rejected.stdout).detail, /SELF_SIGNED_CERT_IN_CHAIN/);
  const failedSetup = await run("untrusted-setup", setupArgs);
  assert.equal(failedSetup.code, 1);
  assert.match(failedSetup.stderr, /SELF_SIGNED_CERT_IN_CHAIN/);
  assert.match(failedSetup.stderr, /NODE_EXTRA_CA_CERTS/);
  console.log(
    "✓ Untrusted certificate rejected by real doctor and setup with actionable diagnosis",
  );

  if (process.platform === "win32") {
    assert.ok(
      process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
      "Native Windows trust test requires a disposable GitHub-hosted runner",
    );
    const der = join(sandbox, "ca.cer");
    openssl(["x509", "-in", ca, "-outform", "DER", "-out", der]);
    const storeScript = join(sandbox, "windows-store.ps1");
    writeFileSync(
      storeScript,
      `
      $ErrorActionPreference = 'Stop'
      $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($env:BIRDYBEEP_TLS_TEST_CERT)
      $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
      $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
      try {
        $matches = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $cert.Thumbprint, $false)
        switch ($env:BIRDYBEEP_TLS_TEST_ACTION) {
          'check' { [Console]::Write($matches.Count) }
          'add' {
            if ($matches.Count -ne 0) { throw 'Generated test CA already exists; refusing to change it' }
            $store.Add($cert)
          }
          'remove' {
            foreach ($match in $matches) { $store.Remove($match) }
            if ($store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $cert.Thumbprint, $false).Count -ne 0) {
              throw 'Test CA cleanup failed'
            }
          }
        }
      } finally { $store.Close(); $cert.Dispose() }
    `,
    );
    const store = (action) =>
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", storeScript],
        {
          encoding: "utf8",
          timeout: 15000,
          env: {
            ...process.env,
            BIRDYBEEP_TLS_TEST_CERT: der,
            BIRDYBEEP_TLS_TEST_ACTION: action,
          },
        },
      ).trim();
    assert.equal(store("check"), "0", "Only a newly generated test root may be installed");
    removeWindowsRoot = () => store("remove");
    store("add");
    assert.equal(store("check"), "1", "Generated root must be present in the native store");
  }

  const trusted = await run("trusted-doctor", ["doctor", "--json"], "system");
  assert.equal(network(trusted.stdout).ok, true);
  const paired = await run("trusted-setup", setupArgs, "system");
  assert.equal(paired.code, 0, paired.stderr);
  assert.equal(JSON.parse(paired.stdout.trim().split("\n").at(-1)).paired, true);
  console.log(
    `✓ System-trusted CA accepted by doctor and setup (${process.platform === "darwin" ? "isolated store-read injection" : "native OS store"})`,
  );

  const wrongHost = await run(
    "wrong-host",
    ["doctor", "--json"],
    "system",
    baseUrl.replace("localhost", "127.0.0.1"),
  );
  assert.equal(wrongHost.code, 1);
  assert.equal(network(wrongHost.stdout).ok, false);
  assert.match(network(wrongHost.stdout).detail, /ERR_TLS_CERT_ALTNAME_INVALID/);
  if (removeWindowsRoot) {
    removeWindowsRoot();
    removeWindowsRoot = undefined;
    const removed = await run("removed-root", ["doctor", "--json"]);
    assert.equal(removed.code, 1);
    assert.equal(network(removed.stdout).ok, false);
    assert.match(network(removed.stdout).detail, /SELF_SIGNED_CERT_IN_CHAIN/);
    console.log("✓ Temporary Windows root removed; a fresh CLI process rejects it again");
  }
  const extra = await run("extra-ca", ["doctor", "--json"], "extra");
  assert.equal(network(extra.stdout).ok, true);
  console.log("✓ Hostname verification retained and NODE_EXTRA_CA_CERTS preserved");
} finally {
  try {
    removeWindowsRoot?.();
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(sandbox, { recursive: true, force: true });
  }
}
