/**
 * `birdybeep login` (§7.1/§7.2/§9.4) — pair this machine via the device-code flow.
 * `POST /v1/pair/start` (machine_label derived from hostname/OS) → show `qr_payload` +
 * `user_code` → poll `POST /v1/pair/token` with the device code (+ stable machine
 * fingerprint) until it returns the durable token or the `expires_at` (10-min) deadline.
 * The issued token is stored in the SECURE store only (keychain / strict-perm file — never
 * config or the QR); the non-secret apiUrl is persisted. Per SPEC §11 the QR/code carries
 * only short-lived pairing info.
 *
 * fetch/sleep/clock/QR are injectable for hermetic tests; the live pairing pass is the
 * deferred cross-repo follow-up (the shapes here are mirrored from the product).
 */
import { getMachineIdentity, setToken, type TokenStoreOptions } from "@birdybeep/agent-core";

import { resolveApiUrl, writeCliConfig } from "../config";
import { type Command, EXIT } from "../framework";
import { pairStart, pairTokenPoll, type PairTokenResult } from "../pairing";
import { CLI_VERSION } from "../version";

/** Default delay between `/pair/token` polls (the start response has no interval). */
export const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface LoginCommandDeps {
  fetchImpl?: typeof fetch;
  tokenOptions?: TokenStoreOptions;
  /** Injectable delay between polls (default real setTimeout; tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the expiry deadline (default Date.now). */
  now?: () => number;
  /** Render the QR payload (default: a plain line; a QR-matrix renderer is a follow-up). */
  renderQr?: (qrPayload: string) => string;
  pollIntervalMs?: number;
}

export function createLoginCommand(deps: LoginCommandDeps = {}): Command {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = deps.now ?? (() => Date.now());
  const renderQr = deps.renderQr ?? ((qr: string) => `   Scan or open:  ${qr}`);
  const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return {
    name: "login",
    summary: "Pair this machine with your BirdyBeep account (QR or manual)",
    usage: "birdybeep login",
    run: async (ctx) => {
      const apiUrl = resolveApiUrl();
      const identity = getMachineIdentity(); // { label, os, fingerprintHash }
      const start = await pairStart(
        apiUrl,
        { machineLabel: identity.label, os: identity.os, cliVersion: CLI_VERSION },
        fetchImpl,
      );

      if (!ctx.flags.json) {
        ctx.io.line(
          "To pair this machine, scan the code or open the link, then confirm in the app:",
        );
        ctx.io.line(renderQr(start.qr_payload));
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
