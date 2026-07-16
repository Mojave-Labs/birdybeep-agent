/**
 * `birdybeep report-status` (§7.3 step 7, §8.8, §21.2) — push each adapter's pre-event
 * integration status to the backend so the Machines/Integrations screen shows them BEFORE
 * any agent event fires. Sends ONE BATCHED `POST /v1/integrations/status` request
 * ({ integrations: [...] }, machine-token auth), parses the `{ integrations: [...] }`
 * response (surfacing the server's EFFECTIVE status, e.g. Codex → needs_trust), and parses
 * the mirrored error envelope: a 401/403 (unauthorized / forbidden / token_revoked) is
 * TERMINAL (exit non-zero), while offline / 5xx / rate_limit is "deferred" (surfaced, exit 0)
 * so it never blocks install.
 *
 * Request/response/error shapes are mirrored from the product (agent-core). fetch/adapters/
 * token injectable for hermetic tests; the live post is the deferred cross-repo follow-up.
 */
import {
  type AgentAdapter,
  errorEnvelopeSchema,
  getToken,
  type IntegrationStatusItem,
  integrationStatusResponseSchema,
  type TokenStoreOptions,
} from "@birdybeep/agent-core";
import { CLAUDE_CODE_ADAPTER_VERSION, claudeCodeAdapter } from "@birdybeep/claude-code";
import { CODEX_ADAPTER_VERSION, codexAdapter } from "@birdybeep/codex";
import { CURSOR_ADAPTER_VERSION, cursorAdapter } from "@birdybeep/cursor";
import { OPENCODE_ADAPTER_VERSION, opencodeAdapter } from "@birdybeep/opencode";

import { resolveApiUrl } from "../config";
import { type Command, EXIT } from "../framework";

const DEFAULT_ADAPTERS: AgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
  cursorAdapter,
];

/** Per-harness BirdyBeep adapter version (the schema's optional `adapter_version`). */
const ADAPTER_VERSIONS: Record<string, string> = {
  claude_code: CLAUDE_CODE_ADAPTER_VERSION,
  codex: CODEX_ADAPTER_VERSION,
  opencode: OPENCODE_ADAPTER_VERSION,
  cursor: CURSOR_ADAPTER_VERSION,
};

const base = (apiUrl: string): string => apiUrl.replace(/\/$/, "");

async function gatherItems(adapters: AgentAdapter[]): Promise<IntegrationStatusItem[]> {
  return Promise.all(
    adapters.map(async (a) => {
      const [detection, status] = await Promise.all([a.detect(), a.status()]);
      const item: IntegrationStatusItem = { harness: a.id, status };
      if (detection.version !== undefined) item.harness_version = detection.version;
      const adapterVersion = ADAPTER_VERSIONS[a.id];
      if (adapterVersion !== undefined) item.adapter_version = adapterVersion;
      return item;
    }),
  );
}

export interface ReportStatusCommandDeps {
  adapters?: AgentAdapter[];
  fetchImpl?: typeof fetch;
  tokenOptions?: TokenStoreOptions;
}

export function createReportStatusCommand(deps: ReportStatusCommandDeps = {}): Command {
  const adapters = deps.adapters ?? DEFAULT_ADAPTERS;
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    name: "report-status",
    summary: "Internal: report integration status to the backend",
    usage: "birdybeep report-status [--json]",
    run: async (ctx) => {
      const token = await getToken(deps.tokenOptions ?? {});
      if (token === null) {
        ctx.io.errline("No machine token — run `birdybeep pair` first.");
        return EXIT.ERROR;
      }

      const items = await gatherItems(adapters);
      if (items.length === 0) {
        ctx.io.emit("No integrations to report.", { outcome: "reported", integrations: [] });
        return EXIT.OK;
      }

      // The effective per-harness status to display; defaults to what we sent, overwritten by
      // the server's response when it 200s.
      let effective = items.map((i) => ({ harness: i.harness, status: i.status }));
      let outcome: "reported" | "deferred" | "terminal" = "deferred";
      let errorCode: string | undefined;

      try {
        const res = await fetchImpl(`${base(resolveApiUrl())}/v1/integrations/status`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ integrations: items }),
        });
        if (res.ok) {
          outcome = "reported";
          const parsed = integrationStatusResponseSchema.safeParse(
            await res.json().catch(() => undefined),
          );
          if (parsed.success) {
            effective = parsed.data.integrations.map((i) => ({
              harness: i.harness,
              status: i.status,
            }));
          }
        } else {
          const env = errorEnvelopeSchema.safeParse(await res.json().catch(() => undefined));
          errorCode = env.success ? env.data.error.code : undefined;
          // The error CODE is the canonical terminal signal (auth failures); HTTP status is
          // only the fallback when the envelope didn't parse. Everything else → deferred.
          const terminal =
            errorCode !== undefined
              ? errorCode === "unauthorized" ||
                errorCode === "forbidden" ||
                errorCode === "token_revoked"
              : res.status === 401 || res.status === 403;
          outcome = terminal ? "terminal" : "deferred";
        }
      } catch {
        outcome = "deferred"; // offline / transport error → surfaced, not fatal
      }

      if (ctx.flags.json) {
        ctx.io.result({
          outcome,
          integrations: effective,
          ...(errorCode !== undefined ? { error: errorCode } : {}),
        });
      } else if (outcome === "terminal") {
        ctx.io.errline(
          `Report rejected (${errorCode ?? "auth"}) — your token may be revoked. Re-run \`birdybeep pair\`.`,
        );
      } else {
        for (const e of effective) {
          ctx.io.line(
            outcome === "reported"
              ? `✓  ${e.harness}: ${e.status} (reported)`
              : `•  ${e.harness}: ${e.status} (deferred — backend unreachable)`,
          );
        }
      }

      // Terminal auth failure → non-zero; offline/deferred → 0 (must never block install).
      return outcome === "terminal" ? EXIT.ERROR : EXIT.OK;
    },
  };
}
