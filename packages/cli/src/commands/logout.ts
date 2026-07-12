/**
 * `birdybeep logout` / `birdybeep unpair` (§9.4) — remove this machine's pairing.
 *
 * They differ on purpose:
 *   - `logout` is LOCAL ONLY: it removes the machine token from BOTH the OS keychain and the
 *     strict-perm file fallback. It does not touch the server — use it to sign this box out
 *     without revoking the installation (you can re-pair the SAME machine later).
 *   - `unpair` is the true reverse of `pair`: it REVOKES the machine server-side (best-effort
 *     `POST /v1/machine/revoke-self` with the machine token) so the machine disappears from the
 *     app, AND then clears the local token. If the server can't be reached, it still clears the
 *     local token and tells you to revoke the machine in the app so a ghost row can't linger.
 *
 * Both are idempotent (no error when already signed out) and never touch harness integration
 * config (that is `agent uninstall`) or the local queue.
 */
import { clearToken, getToken, type TokenStoreOptions } from "@birdybeep/agent-core";

import { resolveApiUrl } from "../config";
import { type Command, EXIT } from "../framework";

export interface LogoutCommandDeps {
  /** Token-store options (tests inject the file fallback). */
  tokenOptions?: TokenStoreOptions;
}

export interface UnpairCommandDeps extends LogoutCommandDeps {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Bound on the server round-trip so `unpair` can never hang on a dead network. Default 10s. */
  timeoutMs?: number;
}

const base = (apiUrl: string): string => apiUrl.replace(/\/$/, "");

export function createLogoutCommand(deps: LogoutCommandDeps = {}): Command {
  return {
    name: "logout",
    summary: "Remove the local machine token (does NOT revoke the machine server-side)",
    usage: "birdybeep logout",
    run: async (ctx) => {
      await clearToken(deps.tokenOptions ?? {});
      ctx.io.emit("Logged out — the machine token was removed.", { loggedOut: true });
      return EXIT.OK;
    },
  };
}

/** Outcome of the best-effort server-side revoke during `unpair`. */
type RevokeOutcome =
  | "revoked" // server confirmed the machine is gone (2xx, or already-revoked 403)
  | "no_token" // nothing to revoke — there was no local token to begin with
  | "unreachable" // couldn't reach the server (offline / timeout) — machine may still show
  | "rejected"; // server answered but didn't confirm removal (e.g. 401/5xx)

async function revokeSelf(
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<RevokeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base(resolveApiUrl())}/v1/machine/revoke-self`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    // 2xx → revoked now. 403 (token_revoked) → it was already revoked server-side, so the
    // machine is already gone: from the user's view, unpaired either way. Anything else
    // (401 invalid token, 5xx, 429) → we can't confirm removal.
    if (res.ok || res.status === 403) return "revoked";
    return "rejected";
  } catch {
    return "unreachable"; // offline / DNS / timeout (abort) — never fatal; local clear proceeds
  } finally {
    clearTimeout(timer);
  }
}

export function createUnpairCommand(deps: UnpairCommandDeps = {}): Command {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  return {
    name: "unpair",
    summary: "Unpair this machine — revoke it server-side and remove the local token",
    usage: "birdybeep unpair",
    run: async (ctx) => {
      const token = await getToken(deps.tokenOptions ?? {});
      const outcome: RevokeOutcome =
        token === null ? "no_token" : await revokeSelf(token, fetchImpl, timeoutMs);

      // Always clear the local token afterward — idempotent, and `unpair` must succeed even
      // fully offline (the server revoke is best-effort). Ordered AFTER the revoke so the
      // token is still available to authenticate it.
      await clearToken(deps.tokenOptions ?? {});

      const serverRevoked = outcome === "revoked";
      const human =
        outcome === "revoked"
          ? "Unpaired — the machine was revoked and removed from your account."
          : outcome === "no_token"
            ? "Already unpaired — there was no local token to remove."
            : outcome === "unreachable"
              ? "Unpaired locally, but the server was unreachable — the machine may still show in the app. Open BirdyBeep and revoke it there to fully remove it."
              : "Unpaired locally, but the server didn't confirm removal — if the machine still shows in the app, revoke it there.";
      ctx.io.emit(human, { unpaired: true, serverRevoked });
      return EXIT.OK;
    },
  };
}
