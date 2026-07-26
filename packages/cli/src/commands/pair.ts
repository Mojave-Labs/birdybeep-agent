/**
 * `birdybeep pair` (§7.1/§7.2/§9.4) — pair this machine via the device-code flow.
 * `POST /v1/pair/start` (machine_label derived from hostname/OS) → show a scannable
 * QR matrix + the pair link + `user_code` → poll `POST /v1/pair/token` with the device
 * code (+ stable machine fingerprint) until it returns the durable token or the
 * `expires_at` (10-min) deadline. The issued token is stored in the SECURE store only
 * (keychain / strict-perm file — never config or the QR); the non-secret apiUrl is
 * persisted. Per SPEC §11 the QR/code carries only short-lived pairing info.
 *
 * The QR matrix (birdybeep-agent-pe1) renders only on an interactive TTY — piped/CI
 * output keeps the plain link + code lines, which are ALWAYS printed as the SSH/
 * headless fallback (docs/pairing.md "Headless and SSH machines"). In `--json` mode
 * the pairing info is emitted as an NDJSON line up front (status "pairing_started")
 * so scripts/agents can read the code and approve — previously json mode printed
 * nothing until success, making scripted pairing impossible (birdybeep-agent-pe1).
 *
 * fetch/sleep/clock/QR/TTY are injectable for hermetic tests.
 */
import {
  deriveCodeChallengeS256,
  generateCodeVerifier,
  getMachineIdentity,
  setToken,
  type TokenStoreOptions,
} from "@birdybeep/agent-core";
// uqr is the CLI's ONLY third-party runtime dep (MIT, itself zero-dependency), pinned
// EXACTLY in package.json: QR encoding (Reed–Solomon + masking) is too error-prone to
// vendor, and a floating range would defeat the small-auditable-supply-chain goal (§16.4).
import { renderUnicodeCompact } from "uqr";

import { readCliConfig, resolveApiUrl, writeCliConfig } from "../config";
import { type Command, EXIT } from "../framework";
import { pairStart, pairTokenPoll, type PairTokenResult } from "../pairing";
import { CLI_VERSION } from "../version";

/** Default delay between `/pair/token` polls (the start response has no interval). */
export const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * How often to reprint a "still waiting…" heartbeat while polling. Without it, `pair`
 * prints the code once and then appears frozen ("stuck doing nothing") for the whole
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
  /** A usage problem (unknown value, stray argument) — the command exits EXIT.USAGE. */
  error?: string;
}

/**
 * Parse `pair`'s own flags out of the post-global argv. Accepts `--expect-email addr` and
 * `--expect-email=addr`; any stray positional is a usage error (pair takes none), so a
 * fat-fingered `birdybeep pair becs@example.com` can never be silently ignored while the
 * confirm gate falls back to prompting.
 */
export function parsePairFlags(args: string[]): PairFlags {
  const flags: PairFlags = { yes: false };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token === "--yes" || token === "-y") {
      flags.yes = true;
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
  yes: boolean;
  nonInteractive: boolean;
  /** Whether stdin can carry an answer (a real terminal), i.e. prompting won't hang. */
  stdinIsTTY: boolean;
}

export type PairConfirmDecision =
  /** Trust the token without asking (a pin matched, or the operator passed `--yes`). */
  | { action: "approve"; reason: "expected_email_match" | "yes_flag" }
  /** Ask the human; `question` is the exact prompt to write. */
  | { action: "prompt"; question: string }
  /** Refuse: the token must NOT be persisted, and `message` says why + how to proceed. */
  | {
      action: "reject";
      reason: "expected_email_mismatch" | "expected_email_unverifiable" | "non_interactive";
      message: string;
    };

/** Case/whitespace-insensitive comparison of two email addresses. */
function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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
 *   3. Otherwise ask — and when we CANNOT ask (`--non-interactive`, or stdin isn't a
 *      terminal, e.g. a script or a CI job), fail closed rather than hang or auto-trust.
 */
export function decidePairConfirmation(input: PairConfirmInput): PairConfirmDecision {
  const { approvedByEmail, expectEmail } = input;

  if (expectEmail !== undefined) {
    if (approvedByEmail === undefined) {
      return {
        action: "reject",
        reason: "expected_email_unverifiable",
        message:
          `Pairing refused: --expect-email ${expectEmail} was pinned, but the server did not report ` +
          "which account approved this machine, so the pin could not be verified. The machine token " +
          "was NOT stored. Re-run without --expect-email (and confirm interactively) if that is expected.",
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

  if (input.nonInteractive || !input.stdinIsTTY) {
    const who = approvedByEmail !== undefined ? ` (approved by ${approvedByEmail})` : "";
    return {
      action: "reject",
      reason: "non_interactive",
      message:
        `Pairing needs confirmation${who}, but this is not an interactive terminal, so the machine ` +
        "token was NOT stored. Re-run with `--expect-email <addr>` to pin the approving account " +
        "(recommended for CI), or `--yes` to accept whichever account approved it.",
    };
  }
  return { action: "prompt", question };
}

/** Is a prompt answer an explicit yes? Anything else (incl. empty/EOF) means no. */
export function isAffirmative(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

/**
 * Ask on stderr, read one line from stdin. stderr (not stdout) so `--json` output stays a
 * clean NDJSON stream. EOF/close resolves to "" (a decline) so the CLI can never hang
 * waiting for an answer that will never come.
 */
async function promptOnStdin(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const done = (value: string): void => {
      if (settled) return;
      settled = true;
      rl.close();
      // The interface resumed stdin; unref so a lingering TTY handle can't hold the process open.
      process.stdin.unref?.();
      resolve(value);
    };
    rl.question(question).then(done, () => done(""));
    rl.once("close", () => done(""));
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
  /** Ask a question and read one line (default {@link promptOnStdin}); injected in tests. */
  promptLine?: (question: string) => Promise<string>;
  /** The pinned identity from config (default: the `expectEmail` key of the CLI config). */
  configuredExpectEmail?: () => string | undefined;
}

export function createPairCommand(deps: PairCommandDeps = {}): Command {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = deps.now ?? (() => Date.now());
  const renderQr = deps.renderQr ?? renderQrMatrix;
  const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const promptLine = deps.promptLine ?? promptOnStdin;
  // Tolerant read: the config file is user-editable, so a non-string/empty pin is treated as
  // "no pin" rather than crashing `pair` (or, worse, comparing against garbage).
  const configuredExpectEmail =
    deps.configuredExpectEmail ??
    ((): string | undefined => {
      const pinned: unknown = readCliConfig().expectEmail;
      return typeof pinned === "string" && pinned.trim().length > 0 ? pinned : undefined;
    });

  return {
    name: "pair",
    summary: "Pair this machine with your BirdyBeep account (QR or manual)",
    usage: "birdybeep pair [--yes] [--expect-email <addr>] [--json]",
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
    ],
    run: async (ctx) => {
      const pairFlags = parsePairFlags(ctx.args);
      if (pairFlags.error !== undefined) {
        ctx.io.errline(`birdybeep pair: ${pairFlags.error}.`);
        return EXIT.USAGE;
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
        // NDJSON: emit the pairing info NOW so a script/agent can surface the code for
        // approval while we poll; the final success object is a later line (pe1).
        ctx.io.result({
          status: "pairing_started",
          user_code: start.user_code,
          qr_payload: start.qr_payload,
          expires_at: start.expires_at,
        });
      } else {
        // Point at the RELIABLE path: the in-app scanner. Opening the https link only
        // reaches the approval screen where universal/app links are configured; scanning
        // (or typing the code) in the app always works, so lead with that.
        ctx.io.line(
          "To pair this machine, open the BirdyBeep app, tap “pair a machine”, and scan this QR (or enter the code):",
        );
        // The matrix is TTY-only (a piped/CI consumer wants greppable lines, and
        // half-block art garbles logs); the link + code lines below ALWAYS print.
        const isTTY = deps.isTTY ?? process.stdout.isTTY === true;
        if (isTTY) ctx.io.line(renderQr(start.qr_payload));
        ctx.io.line(`   Scan or open:  ${start.qr_payload}`);
        ctx.io.line(`   Code:  ${start.user_code}`);
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
          "Pairing timed out before you approved it. In the BirdyBeep app, tap “pair a machine”, scan the QR (or enter the code), then run `birdybeep pair` again.",
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
      const decision = decidePairConfirmation({
        ...(approvedBy !== undefined ? { approvedByEmail: approvedBy } : {}),
        ...(expectEmail !== undefined ? { expectEmail } : {}),
        yes: pairFlags.yes,
        nonInteractive: ctx.flags.nonInteractive,
        stdinIsTTY: deps.isStdinTTY ?? process.stdin.isTTY === true,
      });

      if (decision.action === "reject") {
        ctx.io.result({ paired: false, reason: decision.reason });
        ctx.io.errline(decision.message);
        return EXIT.ERROR;
      }
      if (decision.action === "prompt" && !isAffirmative(await promptLine(decision.question))) {
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

      // Surface the approving account (dgxd) when the server reports it, so the trusted
      // identity is on the record. Additive: absent from older servers.
      const humanSuffix = approvedBy !== undefined ? ` to ${approvedBy}` : "";
      ctx.io.emit(`✓ Paired${humanSuffix}. Run \`birdybeep test\` to send a test Beep.`, {
        paired: true,
        machineId: paired.machineId,
        ...(approvedBy !== undefined ? { approvedByEmail: approvedBy } : {}),
      });
      return EXIT.OK;
    },
  };
}
