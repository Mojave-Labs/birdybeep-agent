/**
 * `birdybeep logout` / `birdybeep unpair` (§9.4) — remove the local machine token from BOTH
 * the OS keychain and the strict-perm file fallback. `unpair` is the pairing-vocabulary twin
 * of `pair` and `logout` is the familiar sign-out verb; they are the SAME operation, so both
 * are offered. Idempotent (no error when already signed out). Does NOT touch harness
 * integration config (that is `agent uninstall`) or the local queue.
 */
import { clearToken, type TokenStoreOptions } from "@birdybeep/agent-core";

import { type Command, EXIT } from "../framework";

export interface LogoutCommandDeps {
  /** Token-store options (tests inject the file fallback). */
  tokenOptions?: TokenStoreOptions;
}

/**
 * Build a token-clearing command. `logout` and `unpair` share this one handler — only the
 * command name, help copy, and the human/JSON confirmation differ.
 */
function createClearTokenCommand(
  spec: { name: "logout" | "unpair"; summary: string; humanMessage: string; jsonKey: string },
  deps: LogoutCommandDeps = {},
): Command {
  return {
    name: spec.name,
    summary: spec.summary,
    usage: `birdybeep ${spec.name}`,
    run: async (ctx) => {
      await clearToken(deps.tokenOptions ?? {});
      ctx.io.emit(spec.humanMessage, { [spec.jsonKey]: true });
      return EXIT.OK;
    },
  };
}

export function createLogoutCommand(deps: LogoutCommandDeps = {}): Command {
  return createClearTokenCommand(
    {
      name: "logout",
      summary: "Remove the local machine token (same as `unpair`)",
      humanMessage: "Logged out — the machine token was removed.",
      jsonKey: "loggedOut",
    },
    deps,
  );
}

export function createUnpairCommand(deps: LogoutCommandDeps = {}): Command {
  return createClearTokenCommand(
    {
      name: "unpair",
      summary: "Unpair this machine — remove the local machine token (same as `logout`)",
      humanMessage: "Unpaired — the machine token was removed.",
      jsonKey: "unpaired",
    },
    deps,
  );
}
