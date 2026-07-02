/**
 * `birdybeep login` (§7.1/§7.2/§9.4) — pair this machine via the device-code flow.
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
 * Render the QR payload as a terminal-scannable half-block matrix. `border: 2` keeps a
 * quiet zone around the symbol (phone cameras misread flush-against-text QRs).
 */
export function renderQrMatrix(qrPayload: string): string {
  return renderUnicodeCompact(qrPayload, { border: 2 });
}

export interface LoginCommandDeps {
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

export function createLoginCommand(deps: LoginCommandDeps = {}): Command {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = deps.now ?? (() => Date.now());
  const renderQr = deps.renderQr ?? renderQrMatrix;
  const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return {
    name: "login",
    summary: "Pair this machine with your BirdyBeep account (QR or manual)",
    usage: "birdybeep login [--json]",
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
        ctx.io.line(
          "To pair this machine, scan the code or open the link, then confirm in the app:",
        );
        // The matrix is TTY-only (a piped/CI consumer wants greppable lines, and
        // half-block art garbles logs); the link + code lines below ALWAYS print.
        const isTTY = deps.isTTY ?? process.stdout.isTTY === true;
        if (isTTY) ctx.io.line(renderQr(start.qr_payload));
        ctx.io.line(`   Scan or open:  ${start.qr_payload}`);
        ctx.io.line(`   Code:  ${start.user_code}`);
        ctx.io.line("Waiting for confirmation…");
      }

      // Poll /pair/token until approved (201) or the pairing window expires.
      const deadline = Date.parse(start.expires_at);
      let paired: PairTokenResult | undefined;
      while (clock() < deadline) {
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
      }

      if (paired === undefined || paired.status !== "paired") {
        // NDJSON contract: json mode gets a TERMINAL result object on every exit path,
        // so scripts can key off the last parseable line instead of only the exit code.
        ctx.io.result({ paired: false, reason: "timeout" });
        ctx.io.errline(
          "Pairing timed out before it was confirmed. Run `birdybeep login` to retry.",
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
