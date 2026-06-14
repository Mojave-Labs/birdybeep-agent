/**
 * `birdybeep login` (§7.1, §9.4) — pair this machine. Starts a pairing session, shows the
 * user a link + code (QR-friendly; the renderer is injectable), polls until the backend
 * confirms, then stores the issued machine token in the SECURE store (keychain / strict-perm
 * file — never config or the QR) and persists the non-secret apiUrl. Per SPEC §11 the QR/URL
 * carries only short-lived pairing info; the durable token never touches a repo/config file.
 *
 * ⚠ The pairing protocol (pairing.ts) is a PROVISIONAL cross-repo contract — the live
 * `birdybeep login` against the real backend is a deferred follow-up; this is fully
 * stub-tested now. fetch/sleep/clock/QR are injectable for hermetic tests.
 */
import { setToken, type TokenStoreOptions } from "@birdybeep/agent-core";

import { resolveApiUrl, writeCliConfig } from "../config";
import { type Command, EXIT } from "../framework";
import { type PairingPoll, pollPairing, startPairing } from "../pairing";

export interface LoginCommandDeps {
  fetchImpl?: typeof fetch;
  tokenOptions?: TokenStoreOptions;
  /** Injectable delay between polls (default real setTimeout; tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the expiry deadline (default Date.now). */
  now?: () => number;
  /** Render the pair URL (default: a plain link; a QR-matrix renderer is a follow-up). */
  renderQr?: (url: string) => string;
}

export function createLoginCommand(deps: LoginCommandDeps = {}): Command {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = deps.now ?? (() => Date.now());
  const renderQr = deps.renderQr ?? ((url: string) => `   Scan or open:  ${url}`);

  return {
    name: "login",
    summary: "Pair this machine with your BirdyBeep account (QR or manual)",
    usage: "birdybeep login",
    run: async (ctx) => {
      const apiUrl = resolveApiUrl();
      const start = await startPairing(apiUrl, fetchImpl);

      if (!ctx.flags.json) {
        ctx.io.line("To pair this machine, open the link and confirm the code:");
        ctx.io.line(renderQr(start.pairUrl));
        ctx.io.line(`   Code:  ${start.userCode}`);
        ctx.io.line("Waiting for confirmation…");
      }

      // Poll until paired or the pairing window expires.
      const deadline = clock() + start.expiresInMs;
      let paired: PairingPoll | undefined;
      while (clock() < deadline) {
        await sleep(start.intervalMs);
        const poll = await pollPairing(apiUrl, start.pollToken, fetchImpl);
        if (poll.status === "paired" && poll.machineToken !== undefined) {
          paired = poll;
          break;
        }
      }

      if (paired?.machineToken === undefined) {
        ctx.io.errline(
          "Pairing timed out before it was confirmed. Run `birdybeep login` to retry.",
        );
        return EXIT.ERROR;
      }

      // Durable token → secure store ONLY. Non-secret apiUrl → config. Never the reverse.
      await setToken(paired.machineToken, deps.tokenOptions ?? {});
      writeCliConfig({ apiUrl });

      ctx.io.emit(
        `✓ Paired${paired.machineLabel ? ` as ${paired.machineLabel}` : ""}. Run \`birdybeep test\` to send a test Beep.`,
        { paired: true, ...(paired.machineLabel ? { machineLabel: paired.machineLabel } : {}) },
      );
      return EXIT.OK;
    },
  };
}
