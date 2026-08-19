/**
 * `birdybeep pair` (§7.1/§7.2/§9.4) — pair this machine via the device-code flow.
 * `POST /v1/pair/start` (machine_label derived from hostname/OS) → show a scannable
 * QR matrix + the complete pair link + display-only `user_code` → poll `POST /v1/pair/token`
 * with the device
 * code (+ stable machine fingerprint) until it returns the durable token or the
 * `expires_at` (10-min) deadline. The issued token is stored in the SECURE store only
 * (keychain / strict-perm file — never config or the QR); the non-secret apiUrl is
 * persisted. Per SPEC §11 the QR/link carries only short-lived pairing info; its fragment
 * contains the approval secret, so the displayed user code cannot approve by itself.
 *
 * The QR matrix (birdybeep-agent-pe1) renders only on an interactive TTY — piped/CI
 * output keeps the plain link + display-code lines, which are ALWAYS printed as the SSH/
 * headless fallback (docs/pairing.md "Headless and SSH machines"). In `--json` mode
 * the pairing info is emitted as an NDJSON line up front (status "pairing_started")
 * so scripts/agents can surface the complete QR payload for approval — previously json mode printed
 * nothing until success, making scripted pairing impossible (birdybeep-agent-pe1).
 *
 * fetch/sleep/clock/QR/TTY are injectable for hermetic tests.
 */
import { closeSync, openSync } from "node:fs";

import {
  clearUnpairedNotice,
  deriveCodeChallengeS256,
  generateCodeVerifier,
  getMachineIdentity,
  getToken,
  LocalEventQueue,
  setToken,
  type TokenStoreOptions,
} from "@birdybeep/agent-core";
// uqr is the CLI's ONLY third-party runtime dep (MIT, itself zero-dependency), pinned
// EXACTLY in package.json: QR encoding (Reed–Solomon + masking) is too error-prone to
// vendor, and a floating range would defeat the small-auditable-supply-chain goal (§16.4).
import { renderUnicodeCompact } from "uqr";

import { cliConfigPath, readCliConfig, resolveApiUrl, writeCliConfig } from "../config";
import { type Command, type CommandContext, EXIT } from "../framework";
import { pairStart, pairTokenPoll, type PairTokenResult } from "../pairing";
import { CLI_VERSION } from "../version";
import { runHarnessSetup, type SetupDeps, type SetupReport } from "./setup";

/** Default delay between `/pair/token` polls (the start response has no interval). */
export const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * How often to reprint a "still waiting…" heartbeat while polling. Without it, `pair`
 * prints the pairing instructions once and then appears frozen ("stuck doing nothing") for the whole
 * 10-minute window — the reported bug. Time-gated on the injected clock so it never
 * fires spuriously in the fast, instant-sleep tests.
 */
export const HEARTBEAT_MS = 15_000;

/**
 * Render the QR payload as a terminal-scannable half-block matrix. `border: 2` keeps a
 * quiet zone around the symbol (phone cameras misread flush-against-text QRs).
 */
export function renderQrMatrix(qrPayload: string): string {
  return renderUnicodeCompact(qrPayload, { border: 2 });
}

/** What the caller asked for on the command line (beyond the global flags). */
export interface PairFlags {
  /** `--yes` / `-y`: skip the interactive confirm (CI/headless escape hatch). */
  yes: boolean;
  /** `--expect-email <addr>`: pin the identity that must have approved this pairing. */
  expectEmail?: string;
  /** `--no-install`: stop after the token — don't detect or install any harness (gcgp.5). */
  noInstall: boolean;
  /** `--no-test`: don't send the closing test Beep (gcgp.5). */
  noTest: boolean;
  /** A usage problem (unknown value, stray argument) — the command exits EXIT.USAGE. */
  error?: string;
}

/**
 * Parse `pair`/`setup`'s own flags out of the post-global argv. Accepts `--expect-email addr` and
 * `--expect-email=addr`; any stray positional is a usage error (neither verb takes one), so a
 * fat-fingered `birdybeep pair becs@example.com` can never be silently ignored while the
 * confirm gate falls back to prompting.
 */
export function parsePairFlags(args: string[]): PairFlags {
  const flags: PairFlags = { yes: false, noInstall: false, noTest: false };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token === "--yes" || token === "-y") {
      flags.yes = true;
    } else if (token === "--no-install") {
      flags.noInstall = true;
    } else if (token === "--no-test") {
      flags.noTest = true;
    } else if (token === "--expect-email" || token.startsWith("--expect-email=")) {
      const inline = token.startsWith("--expect-email=")
        ? token.slice("--expect-email=".length)
        : undefined;
      const value = inline ?? args[++i];
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        return { ...flags, error: "--expect-email requires an email address" };
      }
      flags.expectEmail = value;
    } else {
      return { ...flags, error: `unexpected argument "${token}"` };
    }
  }
  return flags;
}

/**
 * The confirm gate's inputs (birdybeep-md60). `approvedByEmail` is what the server said
 * approved this pairing; everything else is how the operator invoked the CLI.
 */
export interface PairConfirmInput {
  /** `approved_by_email` from `/v1/pair/token` — absent on older servers. */
  approvedByEmail?: string;
  /** The pinned identity (`--expect-email`, else the `expectEmail` config key). */
  expectEmail?: string;
  /**
   * WHERE the pin came from — the remedy differs. A `--flag` pin can simply be dropped from the
   * next invocation; a `config` pin lives in a file and there is no CLI switch that ignores it,
   * so the message has to name the file instead of suggesting an impossible re-run.
   */
  expectEmailSource?: "flag" | "config";
  yes: boolean;
  nonInteractive: boolean;
  /** Whether stdin can carry an answer (a real terminal), i.e. prompting won't hang. */
  stdinIsTTY: boolean;
  /**
   * Whether the process can still reach its CONTROLLING TERMINAL (`/dev/tty`) even though stdin
   * isn't one. This is the difference between "a human is sitting here but their shell hands us
   * pipe-backed stdio" and "nobody is there at all" (a script, a CI job): only the latter may
   * fail closed, the former gets prompted on the terminal it actually has. Always false on
   * Windows — see {@link canOpenControllingTerminal}.
   */
  controllingTerminalAvailable: boolean;
  /** Platform, for platform-specific remediation in the reject text. Default `process.platform`. */
  platform?: string;
  /** Where the CLI config file lives, for the config-pin remedy. */
  configPath?: string;
}

export type PairConfirmDecision =
  /** Trust the token without asking (a pin matched, or the operator passed `--yes`). */
  | { action: "approve"; reason: "expected_email_match" | "yes_flag" }
  /**
   * Ask the human. `question` is the exact prompt to write; `on` says WHERE to read the answer
   * — "stdin" when stdin is a terminal, "controlling-terminal" when it isn't but /dev/tty is
   * reachable (POSIX only).
   */
  | { action: "prompt"; question: string; on: "stdin" | "controlling-terminal" }
  /** Refuse: the token must NOT be persisted, and `message` says why + how to proceed. */
  | {
      action: "reject";
      reason: "expected_email_mismatch" | "expected_email_unverifiable" | "non_interactive";
      message: string;
    };

/**
 * Do two addresses denote the SAME account? Trimmed + case-folded, and required to agree both
 * before AND after Unicode NFKC normalization.
 *
 * Why both: NFKC folds visually-distinct code points onto the same ASCII (fullwidth `ｅ` → `e`,
 * ligatures, math letterforms). Comparing only normalized forms would let a server-reported
 * homoglyph address auto-approve against an ASCII pin — the exact wrong-account acceptance this
 * gate exists to stop. Comparing only raw forms would ignore normalization entirely. Requiring
 * agreement means any pair that matches on one side of normalization but not the other is
 * treated as a MISMATCH, which fails closed (the human is asked, or the pin refuses).
 */
function sameEmail(a: string, b: string): boolean {
  const fold = (v: string): string => v.trim().toLowerCase();
  const rawEqual = fold(a) === fold(b);
  const nfkcEqual = fold(a.normalize("NFKC")) === fold(b.normalize("NFKC"));
  return rawEqual && nfkcEqual;
}

/**
 * Decide whether a freshly minted token may be trusted — the whole of the md60 gate, kept
 * pure so every branch is unit-testable and the command body stays a thin wrapper.
 *
 * Order matters:
 *   1. A pinned identity (`--expect-email`) is the strongest signal: it auto-approves on an
 *      exact match and HARD-FAILS on a mismatch — a `--yes` alongside it must not override a
 *      wrong account (that would turn the pin into a no-op).
 *      A pin with no `approved_by_email` to check against also fails: unverifiable ≠ fine.
 *   2. `--yes` is the blunt escape hatch for CI: trust without asking.
 *   3. Otherwise ask — on stdin when it is a terminal, else on the CONTROLLING TERMINAL when one
 *      is still reachable (pipe-backed stdio under a real terminal: MSYS/mintty Git Bash, some
 *      wrappers). Only when there is genuinely no one to ask (`--non-interactive`, a script, CI)
 *      does it fail closed — never hang, never auto-trust.
 */
export function decidePairConfirmation(input: PairConfirmInput): PairConfirmDecision {
  const { approvedByEmail, expectEmail } = input;
  const platform = input.platform ?? process.platform;

  if (expectEmail !== undefined) {
    if (approvedByEmail === undefined) {
      // The remedy depends on where the pin came from: a flag can be dropped, a config key
      // cannot (there is no --no-expect-email), so point at the file instead of a dead end.
      const remedy =
        input.expectEmailSource === "config"
          ? `Remove or correct the "expectEmail" key in ${input.configPath ?? "the BirdyBeep CLI config"} ` +
            "(or upgrade the backend to one that reports the approving account) and re-run."
          : "Re-run without --expect-email (and confirm interactively) if that is expected.";
      return {
        action: "reject",
        reason: "expected_email_unverifiable",
        message:
          `Pairing refused: ${expectEmail} was pinned as the expected approving account, but the ` +
          "server did not report which account approved this machine, so the pin could not be " +
          `verified. The machine token was NOT stored. ${remedy}`,
      };
    }
    if (sameEmail(approvedByEmail, expectEmail)) {
      return { action: "approve", reason: "expected_email_match" };
    }
    return {
      action: "reject",
      reason: "expected_email_mismatch",
      message:
        `Pairing refused: this machine was approved by ${approvedByEmail}, but ${expectEmail} was ` +
        "expected. The machine token was NOT stored. If you did not expect that account to approve " +
        "it, open BirdyBeep and revoke the machine, then re-run `birdybeep pair`.",
    };
  }

  if (input.yes) return { action: "approve", reason: "yes_flag" };

  const question =
    approvedByEmail !== undefined
      ? `Pair this machine to ${approvedByEmail}? [y/N] `
      : "The server did not report which account approved this machine. Pair anyway? [y/N] ";

  // `--non-interactive` is an explicit "never prompt me", so it outranks any terminal we could
  // reach. Otherwise stdin wins when it's a terminal; failing that we ask on the POSIX
  // controlling terminal, which is what makes pipe-backed shells usable. On Windows there is no
  // usable equivalent — see {@link canOpenControllingTerminal} — so it falls through to the
  // refusal below, which is fast and honest rather than a hang.
  if (!input.nonInteractive) {
    if (input.stdinIsTTY) return { action: "prompt", question, on: "stdin" };
    if (input.controllingTerminalAvailable) {
      return { action: "prompt", question, on: "controlling-terminal" };
    }
  }

  const who = approvedByEmail !== undefined ? ` (approved by ${approvedByEmail})` : "";
  // On Windows the usual cause is a non-ConPTY MSYS/mintty shell handing us pipe-backed stdio.
  // `winpty` attaches a real console — which makes stdin itself a TTY, so the ordinary prompt
  // path engages. Name it rather than leaving the user stuck.
  const winptyHint =
    platform === "win32" && !input.nonInteractive
      ? " In Git Bash / MSYS, `winpty birdybeep pair` attaches a real console so the prompt can appear."
      : "";
  return {
    action: "reject",
    reason: "non_interactive",
    message:
      `Pairing needs confirmation${who}, but there is no terminal to ask on, so the machine ` +
      "token was NOT stored. Re-run with `--expect-email <addr>` to pin the approving account " +
      "(recommended for CI), or `--yes` to accept whichever account approved it." +
      winptyHint,
  };
}

/** Is a prompt answer an explicit yes? Anything else (incl. empty/EOF) means no. */
export function isAffirmative(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

/**
 * The device that reaches this process's CONTROLLING TERMINAL regardless of what stdin is wired
 * to. POSIX only — see {@link canOpenControllingTerminal} for why Windows is excluded.
 */
export function controllingTerminalPath(): string {
  return "/dev/tty";
}

/**
 * Can we open the controlling terminal for reading? Probe only — never throws, opens nothing
 * durable. Opening `/dev/tty` succeeds exactly when a terminal really is attached: in a CI job,
 * a daemon, or a detached session (`setsid`) it fails, which is the signal the gate needs.
 *
 * WINDOWS IS DELIBERATELY EXCLUDED. The obvious analogue is the `CONIN$` console device, and an
 * earlier revision used it — but measured on a windows-latest runner with fully piped stdio,
 * `CONIN$` OPENS and then READING it blocks forever. That turns the gate's "fail closed, fast"
 * guarantee into a 60s hang (caught by scripts/live-e2e-pair-headless.mjs before release), which
 * is strictly worse than the refusal it was meant to avoid: a script gets neither an answer nor
 * an error. Since opening it proves nothing on Windows, we don't. Windows users whose shell hands
 * the CLI pipe-backed stdio (MSYS/mintty Git Bash) run `winpty birdybeep pair`, which attaches a
 * real console — stdin then IS a TTY and the ordinary stdin path handles it, no fallback needed.
 */
export function canOpenControllingTerminal(
  path: string = controllingTerminalPath(),
  /** Explicit so tests can pin BOTH branches on any host, without patching process.platform. */
  platform: string = process.platform,
): boolean {
  if (platform === "win32") return false;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    return true;
  } catch {
    return false; // no controlling terminal (script, CI, detached session) → caller fails closed
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Ask a question and read one line back. The question always goes to stderr (not stdout) so
 * `--json` output stays a clean NDJSON stream. EOF/close resolves to "" (a decline) so the CLI
 * can never hang waiting for an answer that will never come.
 *
 * `on: "controlling-terminal"` reads from /dev/tty instead of stdin — a human IS present but the
 * shell gave us pipe-backed stdio.
 *
 * WHY tty.ReadStream over an explicit fd, and not `createReadStream("/dev/tty")`:
 * a plain fs read stream services reads on the libuv THREADPOOL. Once a read is issued it cannot
 * be cancelled — `destroy()` returns, but the `FSReqCallback` stays pending, and because `bin.ts`
 * sets `process.exitCode` (rather than calling `process.exit`) the event loop never drains. The
 * observable bug: after answering the prompt the CLI printed "✓ Paired …" and then HUNG until a
 * keypress or Ctrl-C — flatly contradicting the "never hangs" guarantee this gate is built on.
 * Measured: answer read at +9ms, process still alive at 20s with
 * `process._getActiveRequests() === ['FSReqCallback']`. A `tty.ReadStream` uses a poll-backed
 * handle instead, so closing the fd deterministically here ends the read and the process exits
 * (~0.06s). The fd is ours (we opened it), so we close it exactly once, on every path.
 */
async function promptForAnswer(
  question: string,
  on: "stdin" | "controlling-terminal",
): Promise<string> {
  const { createInterface } = await import("node:readline/promises");

  let ttyFd: number | undefined;
  let input: NodeJS.ReadableStream;
  if (on === "stdin") {
    input = process.stdin;
  } else {
    const { ReadStream } = await import("node:tty");
    ttyFd = openSync(controllingTerminalPath(), "r");
    input = new ReadStream(ttyFd);
  }

  return new Promise<string>((resolve) => {
    const rl = createInterface({ input, output: process.stderr });
    let settled = false;
    const done = (value: string): void => {
      if (settled) return;
      settled = true;
      rl.close();
      if (on === "stdin") {
        // The interface resumed stdin; unref so a lingering TTY handle can't hold the process open.
        process.stdin.unref?.();
      } else {
        // Order matters: unref + destroy the handle, THEN close the fd. Both are wrapped because
        // destroying a tty stream may already have closed it — a double close must never throw
        // out of the prompt (that would turn a successful answer into a crash).
        try {
          (input as { unref?: () => void }).unref?.();
          (input as { destroy?: () => void }).destroy?.();
        } catch {
          /* stream already torn down */
        }
        if (ttyFd !== undefined) {
          try {
            closeSync(ttyFd);
          } catch {
            /* already closed by the stream */
          }
        }
      }
      resolve(value);
    };
    rl.question(question).then(done, () => done(""));
    rl.once("close", () => done(""));
    input.once?.("error", () => done("")); // tty vanished mid-prompt → decline, never hang
  });
}

export interface PairCommandDeps {
  fetchImpl?: typeof fetch;
  tokenOptions?: TokenStoreOptions;
  /** Injectable delay between polls (default real setTimeout; tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the expiry deadline (default Date.now). */
  now?: () => number;
  /** Render the QR payload as a matrix (default {@link renderQrMatrix} via uqr). */
  renderQr?: (qrPayload: string) => string;
  /** Whether stdout is an interactive terminal (default process.stdout.isTTY). The QR
   * matrix renders only on a TTY — piped output stays plain text. */
  isTTY?: boolean;
  pollIntervalMs?: number;
  /**
   * Whether stdin can answer a prompt (default process.stdin.isTTY). Drives the md60 confirm
   * gate's fail-closed branch — a piped/CI stdin never gets prompted.
   */
  isStdinTTY?: boolean;
  /**
   * Whether the controlling terminal is reachable when stdin is NOT a TTY (default: probe
   * /dev/tty; always false on Windows). Injected in tests so both branches are exercised
   * without needing a real terminal.
   */
  hasControllingTerminal?: () => boolean;
  /** Ask a question and read one line (default {@link promptForAnswer}); injected in tests. */
  promptLine?: (question: string, on: "stdin" | "controlling-terminal") => Promise<string>;
  /** The pinned identity from config (default: the `expectEmail` key of the CLI config). */
  configuredExpectEmail?: () => string | undefined;
  /**
   * The one-step chain that runs once the token is stored (gcgp.5): detect + install every
   * harness, print the per-build coverage table, send a real test Beep. On by default — that
   * chain IS the product's setup. `false` turns it off for tests about the pairing handshake
   * alone, which must never touch real adapters or the network.
   */
  setup?: SetupDeps | false;
}

/**
 * Run the post-pairing chain without ever letting it undo a successful pairing. The token is
 * already stored by the time this runs, so a thrown adapter (a harness the installed CLI is too
 * old to understand — this ships on npm and users upgrade when they feel like it) has to degrade
 * into a message plus the granular escape hatch, not a crash on top of a machine that IS paired.
 */
async function runSetupChain(
  ctx: CommandContext,
  deps: SetupDeps,
  flags: PairFlags,
): Promise<SetupReport | undefined> {
  try {
    return await runHarnessSetup(ctx, { sendTest: !flags.noTest }, deps);
  } catch (err) {
    ctx.io.errline(
      `This machine is paired, but wiring up your coding agents failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Run `birdybeep agent install all` to do it on its own, then `birdybeep doctor`.",
    );
    return undefined;
  }
}

/** How the two verbs that run this flow differ — everything else about them is identical. */
interface PairingVerb {
  name: string;
  summary: string;
  usage: string;
  /** One-line "start here" hint; makes the verb the featured entry in the root help. */
  gettingStarted?: string;
  /**
   * Go straight to the harness half when a token already exists, instead of minting another one.
   * `setup` is the verb people re-run after installing a harness, and forcing a phone round-trip
   * for that would make the re-run advice this ticket prints a lie. `pair` always re-pairs.
   */
  skipWhenPaired: boolean;
}

function createPairingCommand(verb: PairingVerb, deps: PairCommandDeps = {}): Command {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = deps.now ?? (() => Date.now());
  const renderQr = deps.renderQr ?? renderQrMatrix;
  const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const promptLine = deps.promptLine ?? promptForAnswer;
  const hasControllingTerminal =
    deps.hasControllingTerminal ?? (() => canOpenControllingTerminal());
  // Tolerant read: the config file is user-editable, so a non-string/empty pin is treated as
  // "no pin" rather than crashing `pair` (or, worse, comparing against garbage).
  const configuredExpectEmail =
    deps.configuredExpectEmail ??
    ((): string | undefined => {
      const pinned: unknown = readCliConfig().expectEmail;
      return typeof pinned === "string" && pinned.trim().length > 0 ? pinned : undefined;
    });

  return {
    name: verb.name,
    summary: verb.summary,
    usage: verb.usage,
    ...(verb.gettingStarted !== undefined ? { gettingStarted: verb.gettingStarted } : {}),
    options: [
      {
        flag: "--yes",
        aliases: ["-y"],
        summary: "Skip the approving-account confirmation (headless/CI)",
      },
      {
        flag: "--expect-email",
        value: "<addr>",
        summary: "Only trust the pairing if this account approved it (else fail)",
      },
      {
        flag: "--no-install",
        summary: "Stop after pairing — don't detect or wire up any coding agent",
      },
      {
        flag: "--no-test",
        summary: "Don't send the test Beep at the end",
      },
    ],
    run: async (ctx) => {
      const pairFlags = parsePairFlags(ctx.args);
      if (pairFlags.error !== undefined) {
        ctx.io.errline(`birdybeep ${verb.name}: ${pairFlags.error}.`);
        return EXIT.USAGE;
      }
      const chain = deps.setup === false || pairFlags.noInstall ? undefined : (deps.setup ?? {});
      // The token store this command was given is the one the chain's test Beep has to read from,
      // so it carries through unless the caller pinned a different one for the chain itself.
      const setupDeps: SetupDeps = {
        ...(deps.tokenOptions !== undefined ? { tokenOptions: deps.tokenOptions } : {}),
        ...chain,
      };

      // `setup` re-run on an already-paired machine goes straight to the harness half. That is
      // the whole point of the "install it, then run `birdybeep setup` again" advice this flow
      // prints — a second phone round-trip for it would be busywork.
      if (verb.skipWhenPaired && (await getToken(deps.tokenOptions ?? {})) !== null) {
        ctx.io.line(
          chain !== undefined
            ? "✓ Already paired — checking which coding agents are wired up."
            : "✓ Already paired. Nothing else to do with --no-install.",
        );
        const report =
          chain !== undefined ? await runSetupChain(ctx, setupDeps, pairFlags) : undefined;
        ctx.io.result({
          paired: true,
          alreadyPaired: true,
          ...(report !== undefined ? { setup: report } : {}),
        });
        return report?.ok === false ? EXIT.ERROR : EXIT.OK;
      }

      const apiUrl = resolveApiUrl();
      const identity = getMachineIdentity(); // { label, os, fingerprintHash }
      // PKCE (dgxd): commit to a fresh random verifier by sending only its S256 challenge on
      // /pair/start; prove possession of the verifier on every /pair/token. The verifier is a
      // short-lived SECRET kept in memory for this `pair` run ONLY — never persisted to disk or
      // the token store. Binds the token mint to THIS CLI so an interceptor of the device_code
      // can't redeem it. A newer server enforces it; an older one ignores it (backward compatible).
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = deriveCodeChallengeS256(codeVerifier);
      const start = await pairStart(
        apiUrl,
        { machineLabel: identity.label, os: identity.os, cliVersion: CLI_VERSION, codeChallenge },
        fetchImpl,
      );

      if (ctx.flags.json) {
        // NDJSON: emit the pairing info NOW so a script/agent can surface the complete
        // qr_payload for approval while we poll; the final success object is a later line.
        ctx.io.result({
          status: "pairing_started",
          user_code: start.user_code,
          qr_payload: start.qr_payload,
          expires_at: start.expires_at,
        });
      } else {
        // Approval needs the high-entropy fragment secret carried by the complete QR/link.
        // The short user_code remains visible only to identify the same pending session.
        ctx.io.line(
          "To pair this machine, open the BirdyBeep app, tap “pair a machine”, and scan this QR or open the complete link:",
        );
        // The matrix is TTY-only (a piped/CI consumer wants greppable lines, and
        // half-block art garbles logs); the link + code lines below ALWAYS print.
        const isTTY = deps.isTTY ?? process.stdout.isTTY === true;
        if (isTTY) ctx.io.line(renderQr(start.qr_payload));
        ctx.io.line(`   Scan or open:  ${start.qr_payload}`);
        ctx.io.line(
          `   Session code (display only; cannot approve by itself):  ${start.user_code}`,
        );
        ctx.io.line("Waiting for you to approve this machine in the app…");
      }

      // Poll /pair/token until approved (201), a TERMINAL error, or the window expires.
      const deadline = Date.parse(start.expires_at);
      const startedAt = clock();
      let lastBeat = startedAt;
      let paired: PairTokenResult | undefined;
      let terminal: Extract<PairTokenResult, { status: "error" }> | undefined;
      for (;;) {
        const nowMs = clock();
        if (nowMs >= deadline) break;
        await sleep(intervalMs);
        const poll = await pairTokenPoll(
          apiUrl,
          start.device_code,
          fetchImpl,
          identity.fingerprintHash,
          codeVerifier, // PKCE proof-of-possession (dgxd) — sent on every poll
        );
        if (poll.status === "paired") {
          paired = poll;
          break;
        }
        // A failure that waiting can't fix (e.g. the agent-install cap) must STOP the loop
        // and be shown — never masked as "not approved yet" so the prompt hangs silently.
        if (poll.status === "error" && !poll.retryable) {
          terminal = poll;
          break;
        }
        // Otherwise pending (not approved yet) or a transient server error → keep waiting,
        // reprinting a heartbeat so the prompt is visibly alive. Human-mode only (NDJSON
        // stays a clean two-line stream); time-gated on the clock so tests never see it.
        if (!ctx.flags.json && nowMs - lastBeat >= HEARTBEAT_MS) {
          ctx.io.line(
            poll.status === "error"
              ? `   still trying — the server is busy (${poll.message}). approve in the app when you can…`
              : "   still waiting — approve this machine in the BirdyBeep app…",
          );
          lastBeat = nowMs;
        }
      }

      if (terminal !== undefined) {
        // NDJSON: a terminal result object on stderr+stdout so scripts see the reason code.
        ctx.io.result({ paired: false, reason: terminal.code });
        ctx.io.errline(`Pairing failed: ${terminal.message}`);
        return EXIT.ERROR;
      }

      if (paired === undefined || paired.status !== "paired") {
        // NDJSON contract: json mode gets a TERMINAL result object on every exit path,
        // so scripts can key off the last parseable line instead of only the exit code.
        ctx.io.result({ paired: false, reason: "timeout" });
        ctx.io.errline(
          "Pairing timed out before you approved it. In the BirdyBeep app, tap “pair a machine”, scan a fresh QR or open its complete link, then run `birdybeep pair` again.",
        );
        return EXIT.ERROR;
      }

      // ── md60: the confirm gate ────────────────────────────────────────────────────
      // The token is minted but NOT yet trusted. Before it is persisted, the human (or a
      // pinned identity) must confirm the account that approved this machine — so a
      // wrong-account or hijacked approval is caught at trust time, before any event flows.
      // Nothing below this point runs unless the gate approves: no token, no config write.
      const approvedBy = paired.approvedByEmail;
      // The flag wins over the config pin, so a one-off `pair` can override a fleet default.
      const expectEmail = pairFlags.expectEmail ?? configuredExpectEmail();
      const stdinIsTTY = deps.isStdinTTY ?? process.stdin.isTTY === true;
      const decision = decidePairConfirmation({
        ...(approvedBy !== undefined ? { approvedByEmail: approvedBy } : {}),
        ...(expectEmail !== undefined ? { expectEmail } : {}),
        ...(expectEmail !== undefined
          ? { expectEmailSource: pairFlags.expectEmail !== undefined ? "flag" : "config" }
          : {}),
        yes: pairFlags.yes,
        nonInteractive: ctx.flags.nonInteractive,
        stdinIsTTY,
        // Probed ONLY when stdin can't answer — opening /dev/tty is a syscall, and when stdin is
        // already a terminal the answer is irrelevant.
        controllingTerminalAvailable: stdinIsTTY ? false : hasControllingTerminal(),
        configPath: cliConfigPath(),
      });

      if (decision.action === "reject") {
        ctx.io.result({ paired: false, reason: decision.reason });
        ctx.io.errline(decision.message);
        return EXIT.ERROR;
      }
      if (
        decision.action === "prompt" &&
        !isAffirmative(await promptLine(decision.question, decision.on))
      ) {
        ctx.io.result({ paired: false, reason: "declined" });
        ctx.io.errline(
          "Pairing declined — the machine token was NOT stored, and this machine will send no " +
            "events. The machine may still appear in the BirdyBeep app; revoke it there if you " +
            "did not intend to pair it.",
        );
        return EXIT.ERROR;
      }

      // Confirmed. Durable token → secure store ONLY. Non-secret apiUrl → config. Never the reverse.
      await setToken(paired.machineToken, deps.tokenOptions ?? {});
      writeCliConfig({ apiUrl });

      // COLD-START GUARD (gcgp.4). A token has just appeared, so the very next hook fire would
      // drain whatever is on the local queue. Everything queued BEFORE this instant belongs to a
      // machine that had nowhere to send it; replaying it means a phone full of notifications
      // about work that finished yesterday, and — because the backend's storm summariser runs
      // ahead of its notify decision — real pushes even for event types that never beep. So the
      // pre-pairing backlog is discarded here, once, at the moment the token is stored. Anything
      // enqueued from now on is an ordinary offline retry and still delivers.
      const discarded = new LocalEventQueue().discardBefore(clock());
      clearUnpairedNotice(); // the "events went nowhere" warning has been answered

      // Surface the approving account (dgxd) when the server reports it, so the trusted
      // identity is on the record. Additive: absent from older servers.
      const humanSuffix = approvedBy !== undefined ? ` to ${approvedBy}` : "";
      const discardedSuffix =
        discarded > 0
          ? ` Discarded ${discarded} event(s) queued before pairing — you won't be beeped about them.`
          : "";
      // gcgp.5: pairing is the WHOLE of setup, so the token is not the end of the run — the
      // harness half follows and the line above it just says what happened. The old copy pointed
      // at `birdybeep test`, which is why a user could pair, get a Beep, and stop with nothing
      // wired up. It only points anywhere now when the chain has been turned off.
      const nextStep =
        chain === undefined ? " Run `birdybeep setup` to wire up your coding agents." : "";
      ctx.io.line(`✓ Paired${humanSuffix}.${nextStep}${discardedSuffix}`);

      const report =
        chain !== undefined ? await runSetupChain(ctx, setupDeps, pairFlags) : undefined;

      ctx.io.result({
        paired: true,
        machineId: paired.machineId,
        discardedPrePairingEvents: discarded,
        ...(approvedBy !== undefined ? { approvedByEmail: approvedBy } : {}),
        ...(report !== undefined ? { setup: report } : {}),
      });
      return report?.ok === false ? EXIT.ERROR : EXIT.OK;
    },
  };
}

/**
 * `birdybeep pair` — mint a machine token, then wire up every coding agent on the machine.
 * Always re-pairs, even when a token is already present.
 */
export function createPairCommand(deps: PairCommandDeps = {}): Command {
  return createPairingCommand(
    {
      name: "pair",
      summary: "Pair this machine and wire up every coding agent on it",
      usage: "birdybeep pair [--yes] [--expect-email <addr>] [--no-install] [--no-test] [--json]",
      skipWhenPaired: false,
    },
    deps,
  );
}

/**
 * `birdybeep setup` — the same flow under the verb people look for. `pair` describes the
 * handshake; `setup` describes the job, and it is the one the root help features. It skips
 * straight to the harness half on a machine that already has a token, so re-running it after
 * installing a new harness costs nothing.
 */
export function createSetupCommand(deps: PairCommandDeps = {}): Command {
  return createPairingCommand(
    {
      name: "setup",
      summary: "Set up BirdyBeep here: pair, wire up every coding agent, test",
      usage: "birdybeep setup [--yes] [--expect-email <addr>] [--no-install] [--no-test] [--json]",
      gettingStarted:
        "Pair this machine, wire up every coding agent it finds, and send a test Beep.",
      skipWhenPaired: true,
    },
    deps,
  );
}
