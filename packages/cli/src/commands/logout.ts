/**
 * `birdybeep logout` (§9.4) — remove the local machine token from BOTH the OS keychain and
 * the strict-perm file fallback. Idempotent (no error when already logged out). Does NOT
 * touch harness integration config (that is `agent uninstall`) or the local queue.
 */
import { clearToken, type TokenStoreOptions } from "@birdybeep/agent-core";

import { type Command, EXIT } from "../framework";

export interface LogoutCommandDeps {
  /** Token-store options (tests inject the file fallback). */
  tokenOptions?: TokenStoreOptions;
}

export function createLogoutCommand(deps: LogoutCommandDeps = {}): Command {
  return {
    name: "logout",
    summary: "Remove the local machine token",
    usage: "birdybeep logout",
    run: async (ctx) => {
      await clearToken(deps.tokenOptions ?? {});
      ctx.io.emit("Logged out — the machine token was removed.", { loggedOut: true });
      return EXIT.OK;
    },
  };
}
