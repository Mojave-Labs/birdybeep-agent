/**
 * `birdybeep pair` proof (hermetic temp HOME, stub device-code backend): POST /v1/pair/start
 * → show QR matrix (TTY only) + qr_payload link + user_code → poll POST /v1/pair/token
 * (validation_failed/4xx = pending) until 201 {machine_token, machine_id}; store the token in
 * the SECURE store, persist the non-secret apiUrl, and NEVER write the token to config/output.
 * An expired window exits non-zero. `--json` is NDJSON: a "pairing_started" line (so scripts
 * can read the code — pe1) then the final success object. Shapes are the product's canonical
 * pairing contract.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getOS, getToken, unavailableKeychainBackend } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { cliConfigPath, writeCliConfig } from "../config";
import { EXIT } from "../framework";
import { CLI_VERSION } from "../version";
import {
  createPairCommand,
  decidePairConfirmation,
  isAffirmative,
  parsePairFlags,
  renderQrMatrix,
} from "./pair";

const MACHINE_TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };
/**
 * The md60 confirm gate stands between the mint and the token store, so every test that
 * expects a SUCCESSFUL pairing has to clear it. These deps are the human path: an
 * interactive stdin that answers "y". The gate's own branches are covered in the
 * "approving-account confirm gate" describe below.
 */
const CONFIRM_YES = {
  isStdinTTY: true,
  hasControllingTerminal: () => false,
  promptLine: () => Promise.resolve("y"),
};
// The canonical qr_payload shape the backend mints (https link carrying ONLY the short code).
const QR_PAYLOAD = "https://birdybeep.com/pair?code=AB-1234";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}

/** Discard both streams for a case whose assertions are about state, not output. */
function quietWriters(): {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
} {
  return { stdout: capture().writer, stderr: capture().writer };
}

/** Stub device-code backend. `/pair/start` opens a session; `/pair/token` is 400 then 201. */
function stubPairing(
  opts: {
    expiresAt?: string;
    alwaysPending?: boolean;
    onStartBody?: (body: unknown) => void;
    /** Capture every `/pair/token` request body so tests can assert the PKCE verifier (dgxd). */
    onTokenBody?: (body: unknown) => void;
    /** Extra fields the 201 `/pair/token` response carries (e.g. approved_by_email — dgxd). */
    tokenResponseExtra?: Record<string, unknown>;
    /** When set, `/pair/token` ALWAYS returns this error code (the terminal-error path). */
    terminalError?: string;
    terminalMessage?: string;
  } = {},
): typeof fetch {
  let polls = 0;
  return ((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const reqBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    if (u.endsWith("/v1/pair/start")) {
      // Capture the request body so tests can assert what the CLI actually sends (s0o7).
      if (opts.onStartBody) opts.onStartBody(reqBody);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "dc_test",
            user_code: "AB-1234",
            qr_payload: QR_PAYLOAD,
            expires_at: opts.expiresAt ?? new Date(Date.now() + 600_000).toISOString(),
          }),
          { status: 200 },
        ),
      );
    }
    // /v1/pair/token — a terminal error (won't resolve by waiting), else validation_failed
    // (400) while pending, then 201 with the token.
    if (opts.onTokenBody) opts.onTokenBody(reqBody);
    polls += 1;
    if (opts.terminalError) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: opts.terminalError,
              message: opts.terminalMessage ?? "agent install limit reached; revoke a machine",
            },
          }),
          { status: 429 },
        ),
      );
    }
    if (opts.alwaysPending || polls < 2) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "validation_failed", message: "not yet approved" } }),
          { status: 400 },
        ),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          machine_token: MACHINE_TOKEN,
          machine_id: "mac_1",
          ...(opts.tokenResponseExtra ?? {}),
        }),
        { status: 201 },
      ),
    );
  }) as unknown as typeof fetch;
}

/**
 * Independent re-implementation of the PRODUCT server's `sha256Base64Url` (packages/db/crypto.ts),
 * transcribed from its EXACT transform (`base64 → +→- /→_ → strip =`) rather than Node's
 * `digest("base64url")` shortcut — so this genuinely cross-checks the CLI's derivation. Verifies
 * the challenge the CLI sent on /pair/start really is base64url(sha256(the verifier it sends on
 * /pair/token)); if these diverge the real server's `sha256Base64Url(verifier) === stored
 * challenge` check would reject the mint.
 */
function serverSha256Base64Url(input: string): string {
  return createHash("sha256")
    .update(input, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("birdybeep pair", () => {
  it("pairs via the device-code flow and stores the token securely (not in config)", async () => {
    sandbox = createSandbox();
    const cmd = createPairCommand({
      fetchImpl: stubPairing(),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
    });
    const out = capture();
    const code = await runCli(["pair"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    expect(out.text()).toContain("AB-1234"); // user code shown (manual path)
    expect(out.text()).toContain(QR_PAYLOAD); // qr_payload link shown
    expect(out.text()).toMatch(/Paired/);

    expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN); // token in the secure store
    const config = readFileSync(cliConfigPath(), "utf8");
    expect(config).toContain("apiUrl");
    expect(config).not.toContain(MACHINE_TOKEN); // never in config
    expect(out.text()).not.toContain(MACHINE_TOKEN); // never printed
  });

  it("renders a scannable QR matrix on a TTY, above the plain link fallback (pe1)", async () => {
    sandbox = createSandbox();
    const cmd = createPairCommand({
      fetchImpl: stubPairing(),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
      isTTY: true, // interactive terminal → the matrix must print
    });
    const out = capture();
    const code = await runCli(["pair"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    // Structural proof: the output embeds EXACTLY the uqr rendering of the payload the
    // stub backend returned. (No pure-JS QR decoder is available without adding a dep,
    // so we assert encode-equivalence; live scan verification is the xrepo E2E's job.)
    expect(out.text()).toContain(renderQrMatrix(QR_PAYLOAD));
    expect(out.text()).toMatch(/[█▀▄]/); // half-block matrix actually present
    expect(out.text()).toContain(QR_PAYLOAD); // link fallback still printed
    expect(out.text()).toContain("AB-1234"); // manual code still printed
  });

  it("prints NO matrix when stdout is not a TTY (piped/CI output stays greppable)", async () => {
    sandbox = createSandbox();
    const cmd = createPairCommand({
      fetchImpl: stubPairing(),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
      isTTY: false,
    });
    const out = capture();
    const code = await runCli(["pair"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    expect(out.text()).not.toMatch(/[█▀▄]/); // no half-block art in pipes
    expect(out.text()).toContain(QR_PAYLOAD); // plain link + code remain
    expect(out.text()).toContain("AB-1234");
  });

  it("sends machine_label + os + cli_version on POST /v1/pair/start (s0o7)", async () => {
    // The mobile approval sheet (06-pair-approve) shows the pending machine's name/OS/CLI
    // version BEFORE consent; the backend can only surface them if the CLI puts them in the
    // /pair/start body. Guards against a regression that drops these to null. The live
    // cross-repo proof lives in the product repo's xrepo-e2e (/v1/pair/inspect round-trip).
    sandbox = createSandbox();
    let startBody: Record<string, unknown> | undefined;
    const cmd = createPairCommand({
      fetchImpl: stubPairing({ onStartBody: (b) => (startBody = b as Record<string, unknown>) }),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
    });
    const out = capture();
    const code = await runCli(["pair"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    expect(startBody).toBeDefined();
    // Required label is always present; os + cli_version are the s0o7 additions.
    expect(typeof startBody?.machine_label).toBe("string");
    expect((startBody?.machine_label as string).length).toBeGreaterThan(0);
    expect(startBody?.os).toBe(getOS()); // normalized for THIS host (macos|windows|linux)
    expect(startBody?.cli_version).toBe(CLI_VERSION); // the @birdybeep/cli version marker
    // Neither field is null/undefined — the sheet would render "unknown" if so.
    expect(startBody?.os).not.toBeNull();
    expect(startBody?.cli_version).not.toBeNull();
  });

  it("--json emits NDJSON: pairing_started (code up front) then the paired result (pe1)", async () => {
    sandbox = createSandbox();
    const cmd = createPairCommand({
      fetchImpl: stubPairing(),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
    });
    const out = capture();
    await runCli(["pair", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    // Every stdout line is machine-readable JSON — no human prose leaks into --json mode.
    const lines = out
      .text()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBe(2);
    // Line 1: the pairing info a script needs to approve (previously never emitted → the
    // operator could not learn the code and json-mode pair always timed out).
    expect(lines[0]).toMatchObject({
      status: "pairing_started",
      user_code: "AB-1234",
      qr_payload: QR_PAYLOAD,
    });
    expect(typeof lines[0]?.expires_at).toBe("string");
    // Final line: unchanged success shape (consumers read the LAST parseable line).
    expect(lines[1]).toMatchObject({ paired: true, machineId: "mac_1" });
    expect(out.text()).not.toContain(MACHINE_TOKEN);
    expect(out.text()).not.toMatch(/[█▀▄]/); // no QR art in json mode
  });

  it("--json emits a terminal {paired:false} object on timeout (scripts read the last line)", async () => {
    sandbox = createSandbox();
    let t = 0;
    const cmd = createPairCommand({
      fetchImpl: stubPairing({ expiresAt: new Date(1_000_000).toISOString(), alwaysPending: true }),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
      now: () => {
        t += 600_000;
        return t;
      },
    });
    const out = capture();
    const err = capture();
    const code = await runCli(["pair", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    const lines = out
      .text()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ status: "pairing_started" });
    expect(lines[lines.length - 1]).toMatchObject({ paired: false, reason: "timeout" });
  });

  it("stops and surfaces a TERMINAL error (quota_exceeded) instead of hanging silently", async () => {
    // Regression for the reported "stuck doing nothing": the backend was returning an
    // actionable error on every poll and the CLI masked it as "not approved yet",
    // polling into a 10-min silent timeout. It must now fail fast with the reason.
    sandbox = createSandbox();
    const cmd = createPairCommand({
      fetchImpl: stubPairing({
        terminalError: "quota_exceeded",
        terminalMessage:
          "agent install limit reached for the free plan; revoke a machine or upgrade",
      }),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
    });
    const out = capture();
    const err = capture();
    const code = await runCli(["pair"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(err.text()).toMatch(/Pairing failed/);
    expect(err.text()).toMatch(/install limit reached/); // the actionable server message is shown
    expect(await getToken(FILE_ONLY)).toBeNull(); // no token minted on a hard failure
  });

  it("--json emits a terminal {paired:false, reason:<code>} on a hard error (scripts see the code)", async () => {
    sandbox = createSandbox();
    const cmd = createPairCommand({
      fetchImpl: stubPairing({ terminalError: "quota_exceeded" }),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
    });
    const out = capture();
    const err = capture();
    const code = await runCli(["pair", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    const lines = out
      .text()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ status: "pairing_started" });
    expect(lines[lines.length - 1]).toMatchObject({ paired: false, reason: "quota_exceeded" });
  });

  it("reprints a heartbeat while waiting so the prompt is visibly alive (not a silent hang)", async () => {
    // The clock advances past HEARTBEAT_MS between polls; the stub approves on poll #2, so
    // exactly one heartbeat prints before success. Proves `pair` isn't "doing nothing".
    sandbox = createSandbox();
    let c = 0;
    const cmd = createPairCommand({
      fetchImpl: stubPairing({ expiresAt: new Date(10_000_000_000_000).toISOString() }),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
      now: () => {
        const v = c;
        c += 16_000; // > HEARTBEAT_MS (15s) so a beat fires each idle poll
        return v;
      },
    });
    const out = capture();
    const code = await runCli(["pair"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(out.text()).toMatch(/still waiting/); // the heartbeat printed
    expect(out.text()).toMatch(/Paired/); // and it still paired
  });

  it("engages the PKCE binding: code_challenge on /pair/start, matching code_verifier on every /pair/token (dgxd)", async () => {
    // The point of the dgxd lockstep: a fresh pair must send an S256 code_challenge on
    // /pair/start AND the code_verifier it hashes to on /pair/token, so the product server can
    // bind the token mint to THIS CLI. We assert the exact wire fields the real server reads,
    // and recompute the challenge from the verifier a DIFFERENT way (serverSha256Base64Url) to
    // prove the transform matches the server's `sha256Base64Url(verifier) === stored challenge`.
    sandbox = createSandbox();
    let startBody: Record<string, unknown> | undefined;
    const tokenBodies: Record<string, unknown>[] = [];
    const cmd = createPairCommand({
      // alwaysPending until poll #2 → at least two /pair/token calls, so we prove the verifier
      // rides EVERY poll (the server checks it on the mint, which may not be the first poll).
      fetchImpl: stubPairing({
        onStartBody: (b) => (startBody = b as Record<string, unknown>),
        onTokenBody: (b) => tokenBodies.push(b as Record<string, unknown>),
      }),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
    });
    const out = capture();
    const code = await runCli(["pair"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);

    // /pair/start carries a non-empty S256 challenge (unpadded base64url, 43 chars for SHA-256).
    const challenge = startBody?.code_challenge;
    expect(typeof challenge).toBe("string");
    expect(challenge as string).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Every /pair/token poll carries the SAME code_verifier (URL-safe, high-entropy, unpadded).
    expect(tokenBodies.length).toBeGreaterThanOrEqual(2);
    const verifiers = new Set(tokenBodies.map((b) => b.code_verifier));
    expect(verifiers.size).toBe(1); // one stable verifier across the whole poll loop
    const verifier = tokenBodies[0]?.code_verifier as string;
    expect(typeof verifier).toBe("string");
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const b of tokenBodies) expect(b.code_verifier).toBe(verifier);

    // The binding must actually hold: challenge === base64url(sha256(verifier)) under the
    // server's exact transform. This is what makes the real server accept the mint.
    expect(challenge).toBe(serverSha256Base64Url(verifier));
  });

  it("surfaces approved_by_email from the /pair/token response when present (dgxd)", async () => {
    sandbox = createSandbox();
    const cmd = createPairCommand({
      fetchImpl: stubPairing({ tokenResponseExtra: { approved_by_email: "becs@example.com" } }),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
    });
    const out = capture();
    const code = await runCli(["pair"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(out.text()).toContain("becs@example.com"); // the approving identity is shown
    expect(out.text()).toMatch(/Paired/);
    expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN); // still stores the token
  });

  it("exits non-zero when the pairing window expires without approval", async () => {
    sandbox = createSandbox();
    let t = 0;
    const cmd = createPairCommand({
      // expires_at fixed at epoch 1,000,000 ms; the injected clock crosses it after one poll.
      fetchImpl: stubPairing({ expiresAt: new Date(1_000_000).toISOString(), alwaysPending: true }),
      tokenOptions: FILE_ONLY,
      sleep: () => Promise.resolve(),
      ...CONFIRM_YES,
      now: () => {
        t += 600_000;
        return t;
      },
    });
    const out = capture();
    const code = await runCli(["pair"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(out.text()).toMatch(/timed out/);
    expect(await getToken(FILE_ONLY)).toBeNull(); // no token on failure
  });
});

/**
 * md60 — defense-in-depth: the server already REPORTS which account approved a pairing
 * (`approved_by_email`), but a passive notice is easy to miss. These prove the CLI turns it
 * into a blocking gate between the mint and the token store: nothing is persisted or trusted
 * until a human confirms (or a pinned identity matches), and the headless paths fail CLOSED
 * instead of hanging or silently trusting a wrong-account approval.
 */
describe("birdybeep pair — approving-account confirm gate (md60)", () => {
  const APPROVER = "becs@example.com";

  describe("decidePairConfirmation (the decision logic)", () => {
    // Default shape: an interactive stdin, so the controlling-terminal fallback is irrelevant.
    const base = {
      yes: false,
      nonInteractive: false,
      stdinIsTTY: true,
      controllingTerminalAvailable: false,
    };

    it("prompts with the approving account when there is nothing pinned", () => {
      const d = decidePairConfirmation({ ...base, approvedByEmail: APPROVER });
      expect(d.action).toBe("prompt");
      // The human must SEE the identity they're being asked about — that is the whole gate.
      expect(d.action === "prompt" && d.question).toContain(APPROVER);
      expect(d.action === "prompt" && d.question).toMatch(/\[y\/N\]/);
      expect(d.action === "prompt" && d.on).toBe("stdin");
    });

    it("still prompts (not auto-trusts) when the server reports no approving account", () => {
      const d = decidePairConfirmation({ ...base });
      expect(d.action).toBe("prompt");
      expect(d.action === "prompt" && d.question).toMatch(/did not report/i);
    });

    it("auto-approves when --expect-email matches (case/space-insensitively)", () => {
      for (const pin of [APPROVER, ` ${APPROVER.toUpperCase()} `]) {
        expect(
          decidePairConfirmation({ ...base, approvedByEmail: APPROVER, expectEmail: pin }),
        ).toEqual({ action: "approve", reason: "expected_email_match" });
      }
    });

    it("hard-fails on an --expect-email mismatch, naming both accounts", () => {
      const d = decidePairConfirmation({
        ...base,
        approvedByEmail: "attacker@evil.test",
        expectEmail: APPROVER,
      });
      expect(d.action).toBe("reject");
      expect(d.action === "reject" && d.reason).toBe("expected_email_mismatch");
      expect(d.action === "reject" && d.message).toContain("attacker@evil.test");
      expect(d.action === "reject" && d.message).toContain(APPROVER);
    });

    it("hard-fails when a pin cannot be verified (server reported no account)", () => {
      // Unverifiable is NOT the same as fine: an older/blinded server must not silently
      // satisfy an identity pin.
      const d = decidePairConfirmation({ ...base, expectEmail: APPROVER });
      expect(d.action).toBe("reject");
      expect(d.action === "reject" && d.reason).toBe("expected_email_unverifiable");
    });

    it("lets a pin mismatch beat --yes (a pin must never degrade to a no-op)", () => {
      const d = decidePairConfirmation({
        ...base,
        yes: true,
        approvedByEmail: "attacker@evil.test",
        expectEmail: APPROVER,
      });
      expect(d.action).toBe("reject");
    });

    it("approves on --yes when nothing is pinned, even with no TTY", () => {
      expect(
        decidePairConfirmation({
          ...base,
          yes: true,
          stdinIsTTY: false,
          approvedByEmail: APPROVER,
        }),
      ).toEqual({ action: "approve", reason: "yes_flag" });
    });

    it("fails closed (never hangs) when there is NO terminal at all", () => {
      for (const input of [
        // A script/CI: pipe-backed stdin AND no controlling terminal to fall back to.
        { ...base, stdinIsTTY: false, approvedByEmail: APPROVER },
        // An explicit "never prompt me" outranks any terminal we could have reached.
        {
          ...base,
          nonInteractive: true,
          controllingTerminalAvailable: true,
          approvedByEmail: APPROVER,
        },
      ]) {
        const d = decidePairConfirmation(input);
        expect(d.action).toBe("reject");
        expect(d.action === "reject" && d.reason).toBe("non_interactive");
        // The error has to teach the escape hatches, or a scripted user is just stuck.
        expect(d.action === "reject" && d.message).toContain("--expect-email");
        expect(d.action === "reject" && d.message).toContain("--yes");
      }
    });

    // The gap the review caught: a human IS present, but their shell handed the CLI pipe-backed
    // stdio (non-ConPTY MSYS/mintty Git Bash is the real-world case). Refusing there would break
    // pairing for those users; prompting on the controlling terminal keeps the gate usable.
    it("falls back to the controlling terminal when stdin isn't a TTY but a terminal exists", () => {
      const d = decidePairConfirmation({
        ...base,
        stdinIsTTY: false,
        controllingTerminalAvailable: true,
        approvedByEmail: APPROVER,
      });
      expect(d.action).toBe("prompt");
      expect(d.action === "prompt" && d.on).toBe("controlling-terminal");
      expect(d.action === "prompt" && d.question).toContain(APPROVER);
    });

    it("prefers stdin over the controlling terminal when stdin IS a TTY", () => {
      const d = decidePairConfirmation({
        ...base,
        stdinIsTTY: true,
        controllingTerminalAvailable: true,
        approvedByEmail: APPROVER,
      });
      expect(d.action === "prompt" && d.on).toBe("stdin");
    });

    it("names `winpty` in the win32 reject text (the Git Bash remedy)", () => {
      const win = decidePairConfirmation({
        ...base,
        stdinIsTTY: false,
        platform: "win32",
        approvedByEmail: APPROVER,
      });
      expect(win.action === "reject" && win.message).toContain("winpty birdybeep pair");
      // …and not on POSIX, where the hint would be noise.
      const posix = decidePairConfirmation({
        ...base,
        stdinIsTTY: false,
        platform: "linux",
        approvedByEmail: APPROVER,
      });
      expect(posix.action === "reject" && posix.message).not.toContain("winpty");
    });

    it("points a CONFIG pin at the config file, not at a flag that cannot be dropped", () => {
      const fromConfig = decidePairConfirmation({
        ...base,
        expectEmail: APPROVER,
        expectEmailSource: "config",
        configPath: "/home/dev/.config/birdybeep/config.json",
      });
      expect(fromConfig.action === "reject" && fromConfig.message).toContain(
        "/home/dev/.config/birdybeep/config.json",
      );
      expect(fromConfig.action === "reject" && fromConfig.message).toContain("expectEmail");
      // There is no CLI switch that ignores a config pin, so it must not suggest one.
      expect(fromConfig.action === "reject" && fromConfig.message).not.toContain(
        "Re-run without --expect-email",
      );

      const fromFlag = decidePairConfirmation({
        ...base,
        expectEmail: APPROVER,
        expectEmailSource: "flag",
      });
      expect(fromFlag.action === "reject" && fromFlag.message).toContain(
        "Re-run without --expect-email",
      );
    });

    it("refuses a homoglyph pin that only matches after NFKC folding", () => {
      // Fullwidth letters NFKC-fold onto ASCII. Comparing only normalized forms would let a
      // server-reported look-alike auto-approve against an ASCII pin.
      const fullwidth = "ｂｅｃｓ@example.com";
      expect(fullwidth.normalize("NFKC")).toBe("becs@example.com"); // the fold really happens
      const d = decidePairConfirmation({
        ...base,
        approvedByEmail: fullwidth,
        expectEmail: "becs@example.com",
      });
      expect(d.action).toBe("reject");
      expect(d.action === "reject" && d.reason).toBe("expected_email_mismatch");
    });
  });

  describe("parsePairFlags / isAffirmative", () => {
    it("parses --yes/-y and both --expect-email spellings", () => {
      expect(parsePairFlags([])).toEqual({ yes: false });
      expect(parsePairFlags(["--yes"])).toEqual({ yes: true });
      expect(parsePairFlags(["-y"]).yes).toBe(true);
      expect(parsePairFlags(["--expect-email", APPROVER]).expectEmail).toBe(APPROVER);
      expect(parsePairFlags([`--expect-email=${APPROVER}`]).expectEmail).toBe(APPROVER);
      expect(parsePairFlags(["--yes", "--expect-email", APPROVER])).toMatchObject({
        yes: true,
        expectEmail: APPROVER,
      });
    });

    it("reports a usage error for a missing value or a stray argument", () => {
      expect(parsePairFlags(["--expect-email"]).error).toBeDefined();
      expect(parsePairFlags(["--expect-email", "--yes"]).error).toBeDefined();
      expect(parsePairFlags(["becs@example.com"]).error).toBeDefined();
    });

    it("treats only y/yes as consent", () => {
      for (const yes of ["y", "Y", "yes", " YES "]) expect(isAffirmative(yes)).toBe(true);
      for (const no of ["", "n", "no", "sure", "yep", "\n"]) expect(isAffirmative(no)).toBe(false);
    });
  });

  describe("through the real `pair` command", () => {
    /** Build a pair command whose backend reports `approved_by_email`. */
    function pairCmd(
      deps: Parameters<typeof createPairCommand>[0] = {},
      approvedByEmail: string | undefined = APPROVER,
    ): ReturnType<typeof createPairCommand> {
      return createPairCommand({
        fetchImpl: stubPairing({
          ...(approvedByEmail !== undefined
            ? { tokenResponseExtra: { approved_by_email: approvedByEmail } }
            : {}),
        }),
        tokenOptions: FILE_ONLY,
        sleep: () => Promise.resolve(),
        ...deps,
      });
    }

    it("DECLINE: shows the account, stores no token, writes no config, exits non-zero", async () => {
      sandbox = createSandbox();
      const asked: string[] = [];
      const cmd = pairCmd({
        isStdinTTY: true,
        promptLine: (q) => {
          asked.push(q);
          return Promise.resolve("n");
        },
      });
      const out = capture();
      const err = capture();
      const code = await runCli(["pair"], {
        commands: [cmd],
        stdout: out.writer,
        stderr: err.writer,
        ensureConfig: false,
      });

      expect(code).toBe(EXIT.ERROR);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain(APPROVER); // the human was shown WHO approved it
      expect(await getToken(FILE_ONLY)).toBeNull(); // ← the point: nothing persisted
      expect(() => readFileSync(cliConfigPath(), "utf8")).toThrow(); // not even the apiUrl
      expect(err.text()).toMatch(/declined/i);
      expect(err.text()).toMatch(/revoke/i); // tells the user how to clean up server-side
      expect(out.text()).not.toContain(MACHINE_TOKEN);
    });

    it("ACCEPT: an interactive `y` stores the token and reports the account", async () => {
      sandbox = createSandbox();
      const cmd = pairCmd({ isStdinTTY: true, promptLine: () => Promise.resolve("y") });
      const out = capture();
      const code = await runCli(["pair"], {
        commands: [cmd],
        stdout: out.writer,
        stderr: capture().writer,
        ensureConfig: false,
      });

      expect(code).toBe(EXIT.OK);
      expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN);
      expect(out.text()).toContain(APPROVER);
    });

    it("prompts on the CONTROLLING TERMINAL when stdin is piped but a terminal exists", async () => {
      // The Git-Bash-without-ConPTY shape: stdin is a pipe, yet a human is sitting at a real
      // terminal. Declining there must still refuse the token — the gate works, it just reads
      // the answer from /dev/tty instead of stdin.
      sandbox = createSandbox();
      const asked: { question: string; on: string }[] = [];
      const cmd = pairCmd({
        isStdinTTY: false,
        hasControllingTerminal: () => true,
        promptLine: (question, on) => {
          asked.push({ question, on });
          return Promise.resolve("n");
        },
      });
      const err = capture();
      const code = await runCli(["pair"], {
        commands: [cmd],
        stdout: capture().writer,
        stderr: err.writer,
        ensureConfig: false,
      });

      expect(code).toBe(EXIT.ERROR);
      expect(asked).toHaveLength(1);
      expect(asked[0]?.on).toBe("controlling-terminal"); // read from /dev/tty, not the pipe
      expect(asked[0]?.question).toContain(APPROVER);
      expect(err.text()).toMatch(/declined/i);
      expect(await getToken(FILE_ONLY)).toBeNull();
    });

    it("accepts on the controlling terminal too (the same fallback, answered yes)", async () => {
      sandbox = createSandbox();
      const cmd = pairCmd({
        isStdinTTY: false,
        hasControllingTerminal: () => true,
        promptLine: () => Promise.resolve("y"),
      });
      const code = await runCli(["pair"], {
        commands: [cmd],
        ...quietWriters(),
        ensureConfig: false,
      });
      expect(code).toBe(EXIT.OK);
      expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN);
    });

    it("--yes pairs without prompting, even with no interactive stdin (CI path)", async () => {
      sandbox = createSandbox();
      let prompted = 0;
      const cmd = pairCmd({
        isStdinTTY: false,
        hasControllingTerminal: () => false,
        promptLine: () => {
          prompted += 1;
          return Promise.resolve("n");
        },
      });
      const code = await runCli(["pair", "--yes"], {
        commands: [cmd],
        ...quietWriters(),
        ensureConfig: false,
      });

      expect(code).toBe(EXIT.OK);
      expect(prompted).toBe(0);
      expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN);
    });

    it("--expect-email pairs unattended on a match", async () => {
      sandbox = createSandbox();
      let prompted = 0;
      const cmd = pairCmd({
        isStdinTTY: false,
        hasControllingTerminal: () => false,
        promptLine: () => {
          prompted += 1;
          return Promise.resolve("n");
        },
      });
      const code = await runCli(["pair", "--expect-email", APPROVER], {
        commands: [cmd],
        ...quietWriters(),
        ensureConfig: false,
      });

      expect(code).toBe(EXIT.OK);
      expect(prompted).toBe(0);
      expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN);
    });

    it("--expect-email MISMATCH refuses the token (the hijacked-approval case)", async () => {
      sandbox = createSandbox();
      const cmd = pairCmd(
        { isStdinTTY: false, hasControllingTerminal: () => false },
        "attacker@evil.test",
      );
      const err = capture();
      const code = await runCli(["pair", "--expect-email", APPROVER], {
        commands: [cmd],
        stdout: capture().writer,
        stderr: err.writer,
        ensureConfig: false,
      });

      expect(code).toBe(EXIT.ERROR);
      expect(await getToken(FILE_ONLY)).toBeNull();
      expect(err.text()).toContain("attacker@evil.test");
    });

    it("a non-TTY stdin without --yes/--expect-email fails closed with a helpful error", async () => {
      sandbox = createSandbox();
      let prompted = 0;
      const cmd = pairCmd({
        isStdinTTY: false,
        hasControllingTerminal: () => false,
        promptLine: () => {
          prompted += 1;
          return new Promise<string>(() => undefined); // would HANG if ever called
        },
      });
      const err = capture();
      const code = await runCli(["pair"], {
        commands: [cmd],
        stdout: capture().writer,
        stderr: err.writer,
        ensureConfig: false,
      });

      expect(code).toBe(EXIT.ERROR);
      expect(prompted).toBe(0); // never prompts a script → never hangs one
      expect(await getToken(FILE_ONLY)).toBeNull();
      expect(err.text()).toContain("--expect-email");
      expect(err.text()).toContain("--yes");
    });

    it("--non-interactive fails closed even on a real terminal", async () => {
      sandbox = createSandbox();
      const cmd = pairCmd({ isStdinTTY: true, promptLine: () => Promise.resolve("y") });
      const code = await runCli(["pair", "--non-interactive"], {
        commands: [cmd],
        ...quietWriters(),
        ensureConfig: false,
      });
      expect(code).toBe(EXIT.ERROR);
      expect(await getToken(FILE_ONLY)).toBeNull();
    });

    it("honors an `expectEmail` pin from the CLI config (and the flag overrides it)", async () => {
      sandbox = createSandbox();
      // Config pins the WRONG account → the pairing must be refused…
      writeCliConfig({ expectEmail: "someone-else@example.com" });
      const refused = await runCli(["pair"], {
        commands: [pairCmd({ isStdinTTY: false, hasControllingTerminal: () => false })],
        ...quietWriters(),
        ensureConfig: false,
      });
      expect(refused).toBe(EXIT.ERROR);
      expect(await getToken(FILE_ONLY)).toBeNull();

      // …until the flag overrides the pin with the account that really approved it.
      const ok = await runCli(["pair", "--expect-email", APPROVER], {
        commands: [pairCmd({ isStdinTTY: false, hasControllingTerminal: () => false })],
        ...quietWriters(),
        ensureConfig: false,
      });
      expect(ok).toBe(EXIT.OK);
      expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN);
    });

    it("--json keeps the NDJSON contract on a decline (last line carries the reason)", async () => {
      sandbox = createSandbox();
      const cmd = pairCmd({ isStdinTTY: true, promptLine: () => Promise.resolve("n") });
      const out = capture();
      const code = await runCli(["pair", "--json"], {
        commands: [cmd],
        stdout: out.writer,
        stderr: capture().writer,
        ensureConfig: false,
      });
      expect(code).toBe(EXIT.ERROR);
      const lines = out
        .text()
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines[0]).toMatchObject({ status: "pairing_started" });
      expect(lines[lines.length - 1]).toMatchObject({ paired: false, reason: "declined" });
      expect(await getToken(FILE_ONLY)).toBeNull();
    });

    it("rejects a malformed invocation before it ever contacts the backend", async () => {
      sandbox = createSandbox();
      let calls = 0;
      const cmd = createPairCommand({
        fetchImpl: (() => {
          calls += 1;
          return Promise.reject(new Error("must not be called"));
        }) as unknown as typeof fetch,
        tokenOptions: FILE_ONLY,
        sleep: () => Promise.resolve(),
      });
      const err = capture();
      // A value-less pin is a usage error, and an unknown flag is caught by the dispatcher.
      for (const argv of [
        ["pair", "--expect-email"],
        ["pair", "--bogus"],
      ]) {
        expect(
          await runCli(argv, {
            commands: [cmd],
            stdout: capture().writer,
            stderr: err.writer,
            ensureConfig: false,
          }),
        ).toBe(EXIT.USAGE);
      }
      expect(calls).toBe(0);
    });

    it("documents both flags in `birdybeep pair --help`", async () => {
      const out = capture();
      await runCli(["pair", "--help"], {
        commands: [createPairCommand()],
        stdout: out.writer,
        stderr: capture().writer,
        ensureConfig: false,
      });
      expect(out.text()).toContain("--yes");
      expect(out.text()).toContain("--expect-email <addr>");
    });
  });
});
