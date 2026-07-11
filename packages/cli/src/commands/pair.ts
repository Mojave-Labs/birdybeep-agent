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
import { getMachineIdentity, setToken, type TokenStoreOptions } from "@birdybeep/agent-core";
// uqr is the CLI's ONLY third-party runtime dep (MIT, itself zero-dependency), pinned
// EXACTLY in package.json: QR encoding (Reed–Solomon + masking) is too error-prone to
// vendor, and a floating range would defeat the small-auditable-supply-chain goal (§16.4).
import { renderUnicodeCompact } from "uqr";

import { resolveApiUrl, writeCliConfig } from "../config";
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
}

export function createPairCommand(deps: PairCommandDeps = {}): Command {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = deps.now ?? (() => Date.now());
  const renderQr = deps.renderQr ?? renderQrMatrix;
  const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return {
    name: "pair",
    summary: "Pair this machine with your BirdyBeep account (QR or manual)",
    usage: "birdybeep pair [--json]",
    run: async (ctx) => {
      const apiUrl = resolveApiUrl();
      const identity = getMachineIdentity(); // { label, os, fingerprintHash }
      const start = await pairStart(
        apiUrl,
        { machineLabel: identity.label, os: identity.os, cliVersion: CLI_VERSION },
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

      // Durable token → secure store ONLY. Non-secret apiUrl → config. Never the reverse.
      await setToken(paired.machineToken, deps.tokenOptions ?? {});
      writeCliConfig({ apiUrl });

      ctx.io.emit(`✓ Paired. Run \`birdybeep test\` to send a test Beep.`, {
        paired: true,
        machineId: paired.machineId,
      });
      return EXIT.OK;
    },
  };
}
