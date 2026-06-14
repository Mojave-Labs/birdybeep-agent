/**
 * `birdybeep report-status` (§7.3 step 7, §8.8, §21.2) — push each adapter's pre-event
 * integration status (`not_detected`/`needs_restart`/`needs_trust`/`error`/`installed`) to
 * the backend so the Machines/Integrations screen shows them BEFORE any agent event fires
 * (the inbound-event path can't derive these). Uses the machine-token auth path; an
 * unreachable backend is surfaced (per-integration "deferred"), never a hard failure, so it
 * can't block install. Codex reports `needs_trust` until its first event.
 *
 * ⚠ PROVISIONAL CROSS-REPO CONTRACT — `POST /v1/integrations/status` shape is not yet
 * pinned in the product repo; the live post is a deferred follow-up (stub-tested now). No
 * §10.1 event schema is involved. fetch/adapters/token injectable for hermetic tests.
 */
import {
  type AgentAdapter,
  getToken,
  type IntegrationStatus,
  type TokenStoreOptions,
} from "@birdybeep/agent-core";
import { claudeCodeAdapter } from "@birdybeep/claude-code";
import { codexAdapter } from "@birdybeep/codex";
import { opencodeAdapter } from "@birdybeep/opencode";

import { resolveApiUrl } from "../config";
import { type Command, EXIT } from "../framework";

const DEFAULT_ADAPTERS: AgentAdapter[] = [claudeCodeAdapter, codexAdapter, opencodeAdapter];

export interface IntegrationStatusReport {
  harness: string;
  status: IntegrationStatus;
  harness_version?: string;
}

/** POST one integration status with machine-token auth. Returns true on a 2xx. */
export async function postIntegrationStatus(
  apiUrl: string,
  report: IntegrationStatusReport,
  token: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const res = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/v1/integrations/status`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  return res.ok;
}

async function gatherReports(adapters: AgentAdapter[]): Promise<IntegrationStatusReport[]> {
  return Promise.all(
    adapters.map(async (a) => {
      const [detection, status] = await Promise.all([a.detect(), a.status()]);
      return {
        harness: a.id,
        status,
        ...(detection.version !== undefined ? { harness_version: detection.version } : {}),
      };
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
        ctx.io.errline("Not logged in — run `birdybeep login` first.");
        return EXIT.ERROR;
      }
      const apiUrl = resolveApiUrl();
      const reports = await gatherReports(adapters);

      const results = [];
      for (const report of reports) {
        let reported = false;
        try {
          reported = await postIntegrationStatus(apiUrl, report, token, fetchImpl);
        } catch {
          reported = false; // offline / transport error → surfaced, not fatal
        }
        results.push({ ...report, reported });
      }

      if (ctx.flags.json) {
        ctx.io.result({ results });
      } else {
        for (const r of results) {
          ctx.io.line(
            r.reported
              ? `✓  ${r.harness}: ${r.status} (reported)`
              : `•  ${r.harness}: ${r.status} (deferred — backend unreachable)`,
          );
        }
      }
      // Offline doesn't hard-fail (must never block install); reporting is best-effort.
      return EXIT.OK;
    },
  };
}
