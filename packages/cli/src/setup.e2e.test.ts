/**
 * ONE-STEP SETUP (birdybeep-agent-gcgp.5) — the owner's acceptance, driven through the real CLI
 * commands in a hermetic temp HOME: a single verb pairs the machine, runs the REAL adapter
 * installs for every harness that is present, prints a per-BUILD coverage table, and sends a real
 * test event that a live loopback sink receives.
 *
 * Setup used to be four commands and four out-of-band steps, and the CLI named two of them: `pair`
 * ended at "Run `birdybeep test`", the Beep arrived, and the machine looked finished with nothing
 * wired up. So the assertions here are about what the RUN ITSELF tells you — that every harness is
 * installed, that Codex's `/hooks` gate and OpenCode's restart are rows in the table rather than
 * silence, and that a harness which is not on the machine says how to finish the job later.
 *
 * The machine modelled in the first case is the acceptance machine: Claude Code, Codex and Cursor
 * present as BOTH a terminal build and a desktop build, OpenCode and Copilot absent. Detection is
 * pinned so the table is deterministic; everything under it — install, status, surface grading,
 * normalize, send — is the production path.
 *
 * Set `BIRDYBEEP_TRANSCRIPT=1` to print the captured stdout of the two acceptance cases verbatim
 * (the ticket asks for the literal transcript, and evidence you cannot regenerate is not evidence).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type AgentAdapter,
  getToken,
  type HarnessSurface,
  setToken,
  unavailableKeychainBackend,
} from "@birdybeep/agent-core";
import {
  BIRDYBEEP_HOOK_COMMAND as CLAUDE_HOOK,
  claudeCodeAdapter,
  claudeSettingsPath,
} from "@birdybeep/claude-code";
import { codexAdapter, codexConfigFile } from "@birdybeep/codex";
import { copilotAdapter, copilotHooksPath } from "@birdybeep/copilot";
import { cursorAdapter, cursorHooksPath } from "@birdybeep/cursor";
import { opencodeAdapter, opencodeConfigFile } from "@birdybeep/opencode";
import {
  createSandbox,
  deliveredBearerToken,
  type EventSink,
  type Sandbox,
  StubEventSink,
} from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./cli";
import { createPairCommand, createSetupCommand, type PairCommandDeps } from "./commands/pair";
import { type SetupDeps } from "./commands/setup";
import { EXIT } from "./framework";

const MACHINE_TOKEN = `bbm_TESTONLY_${randomUUID()}`;
const FILE_ONLY = { backend: unavailableKeychainBackend };
const APPROVAL_SECRET = "ab".repeat(32);

let sandbox: Sandbox | undefined;
let sink: EventSink | undefined;
const ORIGINAL_CODEX_HOME = process.env["CODEX_HOME"];
const ORIGINAL_COPILOT_HOME = process.env["COPILOT_HOME"];
const ORIGINAL_API_URL = process.env["BIRDYBEEP_API_URL"];

beforeEach(() => {
  delete process.env["CODEX_HOME"];
  delete process.env["COPILOT_HOME"];
});
afterEach(async () => {
  sandbox?.cleanup();
  await sink?.close();
  sandbox = undefined;
  sink = undefined;
  if (ORIGINAL_API_URL === undefined) delete process.env["BIRDYBEEP_API_URL"];
  else process.env["BIRDYBEEP_API_URL"] = ORIGINAL_API_URL;
});
afterAll(() => {
  if (ORIGINAL_CODEX_HOME !== undefined) process.env["CODEX_HOME"] = ORIGINAL_CODEX_HOME;
  if (ORIGINAL_COPILOT_HOME !== undefined) process.env["COPILOT_HOME"] = ORIGINAL_COPILOT_HOME;
});

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}

/** Print a captured run verbatim when asked, so the acceptance transcript is reproducible. */
function transcript(title: string, text: string): void {
  if (process.env["BIRDYBEEP_TRANSCRIPT"] !== "1") return;
  console.log(`\n===== ${title} =====\n${text}===== end =====\n`);
}

/** Stub device-code backend: `/pair/start` opens a session, `/pair/token` is pending then 201. */
function stubPairing(): typeof fetch {
  let polls = 0;
  return ((url: string | URL) => {
    if (String(url).endsWith("/v1/pair/start")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "dc_setup",
            user_code: "SU-0001",
            qr_payload: `https://birdybeep.com/pair#code=SU-0001&s=${APPROVAL_SECRET}`,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          }),
          { status: 200 },
        ),
      );
    }
    polls += 1;
    if (polls < 2) {
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
          machine_id: "mac_setup",
          approved_by_email: "you@example.com",
        }),
        { status: 201 },
      ),
    );
  }) as unknown as typeof fetch;
}

function surface(
  id: string,
  kind: "terminal" | "desktop",
  label: string,
  version?: string,
): HarnessSurface {
  return {
    id,
    kind,
    label,
    ...(version !== undefined ? { version } : {}),
    enginePath: `/engines/${id}`,
    configPath: `/config/${id}`,
  };
}

/** A real adapter with its builds pinned, so the REAL install runs against deterministic rows. */
function present(adapter: AgentAdapter, surfaces: HarnessSurface[]): AgentAdapter {
  return {
    ...adapter,
    detect: () =>
      Promise.resolve({
        detected: true,
        ...(surfaces[0]?.version !== undefined ? { version: surfaces[0].version } : {}),
        surfaces,
      }),
  };
}
function absent(adapter: AgentAdapter): AgentAdapter {
  return { ...adapter, detect: () => Promise.resolve({ detected: false, surfaces: [] }) };
}

/**
 * The acceptance machine: Claude Code, Codex and Cursor installed as a terminal build AND a
 * desktop build each; OpenCode and Copilot not installed. The ChatGPT-bundled Codex keeps its
 * version inside the binary, so that row has none — the shape gcgp.6 handles.
 */
function acceptanceAdapters(): AgentAdapter[] {
  return [
    present(claudeCodeAdapter, [
      surface("terminal", "terminal", "terminal CLI", "2.1.227"),
      surface("desktop", "desktop", "Claude desktop app", "2.1.229"),
    ]),
    present(codexAdapter, [
      surface("terminal", "terminal", "terminal CLI", "0.147.0"),
      surface("desktop", "desktop", "ChatGPT desktop app"),
    ]),
    absent(opencodeAdapter),
    present(cursorAdapter, [
      surface("terminal", "terminal", "cursor-agent CLI", "2026.07.09"),
      surface("desktop", "desktop", "Cursor.app", "2.1.9"),
    ]),
    absent(copilotAdapter),
  ];
}

/** Every supported harness missing — the "what do I do now?" case. */
function emptyMachineAdapters(): AgentAdapter[] {
  return [claudeCodeAdapter, codexAdapter, opencodeAdapter, cursorAdapter, copilotAdapter].map(
    absent,
  );
}

interface RunOptions {
  argv: string[];
  adapters: AgentAdapter[];
  /** Extra pair deps (a rejecting fetch, a thrown install, …). */
  deps?: PairCommandDeps;
  /** Extra chain deps merged over the defaults (a sender that cannot be built, …). */
  setupDeps?: SetupDeps;
  /** Build the `setup` verb instead of `pair`. */
  verb?: "setup" | "pair";
}

interface RunResult {
  code: number;
  /** stdout alone — under `--json` this is the NDJSON stream and nothing else. */
  stdout: string;
  /** stderr alone — warnings and failures print here in BOTH modes. */
  stderr: string;
  /** Both streams, for human-mode assertions that don't care which one a line landed on. */
  text: string;
}

/**
 * Start a live sink, point the CLI at it, and drive one real run.
 *
 * stdout and stderr are captured SEPARATELY on purpose: `--json` puts an NDJSON stream on stdout
 * while `io.errline` still writes prose to stderr, so a combined buffer is unparseable exactly
 * when a run has failed — which is the case that matters most.
 */
async function run(options: RunOptions): Promise<RunResult> {
  const started = await StubEventSink.start();
  sink = started;
  process.env["BIRDYBEEP_API_URL"] = started.url;
  const home = sandbox?.home ?? "";
  const factory = options.verb === "pair" ? createPairCommand : createSetupCommand;
  const cmd = factory({
    fetchImpl: stubPairing(),
    tokenOptions: FILE_ONLY,
    sleep: () => Promise.resolve(),
    isStdinTTY: true,
    hasControllingTerminal: () => false,
    promptLine: () => Promise.resolve("y"),
    setup: {
      adapters: options.adapters,
      tokenOptions: FILE_ONLY,
      surfaceOptions: { observedBuilds: { path: join(home, "observed.json") } },
      ...options.setupDeps,
    },
    ...options.deps,
  });
  const out = capture();
  const err = capture();
  const code = await runCli(options.argv, {
    commands: [cmd],
    stdout: out.writer,
    stderr: err.writer,
    ensureConfig: false,
  });
  return { code, stdout: out.text(), stderr: err.text(), text: out.text() + err.text() };
}

/** Parse an NDJSON stdout stream into its objects. */
function ndjson(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("one command sets the whole machine up", () => {
  it("pairs, installs every harness that is there, prints coverage, and lands a real Beep", async () => {
    sandbox = createSandbox();
    const home = sandbox.home;
    const { code, text } = await run({ argv: ["setup"], adapters: acceptanceAdapters() });
    transcript("birdybeep setup — Claude Code, Codex and Cursor installed", text);

    expect(code).toBe(EXIT.OK);
    expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN);

    // The REAL installs ran: each detected harness's config now invokes the BirdyBeep hook, and
    // the two that are not on this machine were left completely alone.
    expect(readFileSync(claudeSettingsPath(home), "utf8")).toContain(CLAUDE_HOOK);
    expect(readFileSync(codexConfigFile({ home }), "utf8")).toContain("birdybeep");
    expect(readFileSync(cursorHooksPath(home), "utf8")).toContain("birdybeep");
    expect(existsSync(opencodeConfigFile({ home }))).toBe(false);
    expect(existsSync(copilotHooksPath({ home, env: {} }))).toBe(false);

    // One row per BUILD, terminal and desktop apart — the gcgp.6 split, at setup time.
    expect(text).toContain("coverage");
    expect(text).toMatch(/Claude Code\s+terminal CLI 2\.1\.227\s+ready/);
    expect(text).toMatch(/Claude Code\s+Claude desktop app 2\.1\.229\s+ready/);
    expect(text).toMatch(/Cursor\s+cursor-agent CLI 2026\.07\.09\s+ready/);
    expect(text).toMatch(/Cursor\s+Cursor\.app 2\.1\.9\s+ready/);

    // Codex is installed but cannot beep until the user trusts the hooks — both of its builds say
    // so, and the adapter's own words (incl. the gcgp.15 migration alarm when it applies) print.
    expect(text).toMatch(/Codex\s+terminal CLI 0\.147\.0\s+needs you/);
    expect(text).toMatch(/Codex\s+ChatGPT desktop app\s+needs you/);
    expect(text).toContain("Open Codex and run /hooks");

    // A harness that is not installed is not a dead end any more.
    expect(text).toMatch(/OpenCode\s+—\s+not installed/);
    expect(text).toMatch(/GitHub Copilot CLI\s+—\s+not installed/);
    expect(text).toContain("Not installed: OpenCode, GitHub Copilot CLI");
    expect(text).toContain("run `birdybeep setup` again");

    // …and the run ends with a real event on the wire, carrying the token pairing just minted.
    const delivered = sink?.received() ?? [];
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.path).toBe("/v1/agent-events");
    expect(deliveredBearerToken(delivered[0]!)).toBe(MACHINE_TOKEN);
    expect((delivered[0]?.body as { event_type?: string }).event_type).toBe("test");
    expect(text).toContain("check your phone for a test Beep");

    // The whole point of one command: no second one is named as required.
    expect(text).not.toMatch(/Run `birdybeep agent install/);
    expect(text).not.toContain(MACHINE_TOKEN);
  });

  it("tells a machine with no coding agent exactly what to install and to come back", async () => {
    sandbox = createSandbox();
    const home = sandbox.home;
    const { code, text } = await run({ argv: ["setup"], adapters: emptyMachineAdapters() });
    transcript("birdybeep setup — no harness installed", text);

    expect(code).toBe(EXIT.OK);
    expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN);
    for (const name of ["Claude Code", "Codex", "OpenCode", "Cursor", "GitHub Copilot CLI"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("No supported coding agent is installed on this machine");
    expect(text).toContain(
      "Install one of Claude Code, Codex, OpenCode, Cursor, GitHub Copilot CLI",
    );
    expect(text).toContain("run `birdybeep setup` again");
    // Nothing was written for a harness that is not there.
    expect(existsSync(claudeSettingsPath(home))).toBe(false);
    expect(existsSync(codexConfigFile({ home }))).toBe(false);
    // Pairing still finished, so the Beep still proves the machine can reach BirdyBeep.
    expect(sink?.received()).toHaveLength(1);
    expect(text).toContain("check your phone for a test Beep");
  });

  it("`pair` runs the same chain — the verb people already know is not a shorter path", async () => {
    sandbox = createSandbox();
    const { code, text } = await run({
      argv: ["pair"],
      adapters: acceptanceAdapters(),
      verb: "pair",
    });
    expect(code).toBe(EXIT.OK);
    expect(text).toContain("✓ Paired to you@example.com.");
    expect(text).toContain("coverage");
    expect(text).toMatch(/Claude Code\s+terminal CLI 2\.1\.227\s+ready/);
    // The old ending sent people to `birdybeep test` and no further.
    expect(text).not.toContain("Run `birdybeep test`");
    expect(readFileSync(claudeSettingsPath(sandbox.home), "utf8")).toContain(CLAUDE_HOOK);
  });

  it("re-running `setup` after installing a harness needs no phone, just the harness half", async () => {
    sandbox = createSandbox();
    await setToken(MACHINE_TOKEN, FILE_ONLY);
    const { code, text } = await run({
      argv: ["setup"],
      adapters: acceptanceAdapters(),
      // Any pairing traffic at all would mean the advice to "run setup again" costs a QR scan.
      deps: {
        fetchImpl: () => Promise.reject(new Error("pairing must not be re-run")),
      },
    });
    expect(code).toBe(EXIT.OK);
    expect(text).toContain("Already paired");
    expect(text).toContain("coverage");
    expect(readFileSync(claudeSettingsPath(sandbox.home), "utf8")).toContain(CLAUDE_HOOK);
  });

  it("keeps a granular escape hatch: `--no-install` pairs only and says what is left", async () => {
    sandbox = createSandbox();
    const home = sandbox.home;
    const { code, text } = await run({
      argv: ["pair", "--no-install"],
      adapters: acceptanceAdapters(),
      verb: "pair",
    });
    expect(code).toBe(EXIT.OK);
    expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN);
    expect(text).toContain("Run `birdybeep setup` to wire up your coding agents.");
    expect(text).not.toContain("coverage");
    expect(existsSync(claudeSettingsPath(home))).toBe(false);
    expect(sink?.received()).toHaveLength(0);
  });

  it("puts an install failure in the table instead of swallowing it, and finishes the rest", async () => {
    sandbox = createSandbox();
    const broken: AgentAdapter = {
      ...claudeCodeAdapter,
      detect: () => Promise.resolve({ detected: true, surfaces: [] }),
      install: () => Promise.reject(new Error("settings.json is read-only")),
    };
    const { code, text } = await run({
      argv: ["setup"],
      adapters: [
        broken,
        present(cursorAdapter, [surface("terminal", "terminal", "cursor-agent CLI", "2026.07.09")]),
      ],
    });
    expect(code).toBe(EXIT.ERROR); // a broken harness must not read as a clean setup
    expect(text).toMatch(/Claude Code\s+—\s+failed/);
    expect(text).toContain("settings.json is read-only");
    expect(text).toContain("`birdybeep agent install claude`");
    // The other harness still got wired up — one bad adapter costs the user nothing else.
    expect(text).toMatch(/Cursor\s+cursor-agent CLI 2026\.07\.09\s+ready/);
    expect(readFileSync(cursorHooksPath(sandbox.home), "utf8")).toContain("birdybeep");
  });

  it("mirrors the whole run in one --json object", async () => {
    sandbox = createSandbox();
    const { code, stdout, text } = await run({
      argv: ["setup", "--json"],
      adapters: acceptanceAdapters(),
    });
    expect(code).toBe(EXIT.OK);
    const lines = ndjson(stdout);
    expect(lines[0]).toMatchObject({ status: "pairing_started" });

    const final = lines[lines.length - 1] as {
      paired: boolean;
      setup: {
        ok: boolean;
        counts: { installed: number; needsYou: number; notInstalled: number; failed: number };
        beep: { outcome: string };
        harnesses: { harness: string; rows: { build?: string; state: string }[] }[];
      };
    };
    expect(final.paired).toBe(true);
    expect(final.setup.ok).toBe(true);
    expect(final.setup.counts).toEqual({
      installed: 3,
      needsYou: 1,
      notInstalled: 2,
      failed: 0,
    });
    expect(final.setup.beep.outcome).toBe("delivered");
    const codex = final.setup.harnesses.find((h) => h.harness === "codex");
    expect(codex?.rows.map((r) => r.state)).toEqual(["needs you", "needs you"]);
    expect(text).not.toContain(MACHINE_TOKEN);
  });
});

/**
 * REGRESSION (Codex review of PR #66) — the epic's own recurring bug, inverted.
 *
 * When the chain threw outright, the catch printed "wiring up your coding agents failed" and then
 * returned `undefined`. Both callers read that as "no setup ran", exited 0, and OMITTED `setup`
 * from the `--json` report: a human saw the failure, and every machine consumer — CI, a script,
 * anything piping `--json` — was told the machine was set up. A silent success on the one command
 * whose whole job is telling you whether your machine is wired up.
 *
 * These two cases also pin the distinction the design draws, which the fix must not collapse:
 *   - ONE ADAPTER throwing is a `failed` ROW. The rest of the run completes (a CLI on npm meets
 *     harnesses newer than itself), so it never sets the chain-level `error`.
 *   - THE CHAIN ITSELF failing is a `error` on the report. Nothing was graded, so there are no
 *     rows to speak of — and it must never read as success.
 */
describe("a setup that failed never reports success", () => {
  it("exits non-zero AND names the failure in --json, not only on screen", async () => {
    sandbox = createSandbox();
    const { code, stdout, stderr } = await run({
      argv: ["setup", "--json"],
      adapters: acceptanceAdapters(),
      // The reviewer's own example: the closing test cannot build its sender because the token
      // store is unreadable. Thrown from inside the chain, after the harness half has run.
      setupDeps: {
        createSender: () => {
          throw new Error("token store is unreadable");
        },
      },
    });

    transcript("birdybeep setup --json — the chain itself fails", `${stdout}${stderr}`);

    // 1. The exit code — the only thing a shell script sees.
    expect(code).toBe(EXIT.ERROR);

    const final = ndjson(stdout).at(-1) as {
      paired: boolean;
      setup?: { ok: boolean; error?: string };
    };
    // 2. Pairing genuinely happened and must NOT be reported as a failure.
    expect(final.paired).toBe(true);
    expect(await getToken(FILE_ONLY)).toBe(MACHINE_TOKEN);
    // 3. …but the report has to carry the failure rather than omit the whole `setup` key.
    expect(final.setup).toBeDefined();
    expect(final.setup?.ok).toBe(false);
    expect(final.setup?.error).toContain("token store is unreadable");
    // 4. The human sentence still prints — it was never the problem, it was the ONLY signal.
    expect(stderr).toContain("wiring up your coding agents failed");
    expect(stderr).toContain("birdybeep agent install all");
  });

  it("keeps a thrown adapter a row, not a chain failure", async () => {
    sandbox = createSandbox();
    const broken: AgentAdapter = {
      ...claudeCodeAdapter,
      detect: () => Promise.resolve({ detected: true, surfaces: [] }),
      install: () => Promise.reject(new Error("settings.json is read-only")),
    };
    const { code, stdout } = await run({
      argv: ["setup", "--json"],
      adapters: [
        broken,
        present(cursorAdapter, [surface("terminal", "terminal", "cursor-agent CLI", "2026.07.09")]),
      ],
    });

    const final = ndjson(stdout).at(-1) as {
      setup: {
        ok: boolean;
        error?: string;
        counts: { failed: number; installed: number };
        harnesses: { harness: string; error?: string; rows: { state: string }[] }[];
      };
    };
    expect(code).toBe(EXIT.ERROR); // still not a clean setup — one harness cannot beep
    expect(final.setup.ok).toBe(false);
    // The chain RAN. Attributing this to the chain would send the user looking in the wrong place.
    expect(final.setup.error).toBeUndefined();
    expect(final.setup.counts.failed).toBe(1);
    const claude = final.setup.harnesses.find((h) => h.harness === "claude_code");
    expect(claude?.error).toContain("settings.json is read-only");
    expect(claude?.rows.map((r) => r.state)).toEqual(["failed"]);
    // …and the other harness was still wired up.
    expect(final.setup.counts.installed).toBe(1);
  });
});
