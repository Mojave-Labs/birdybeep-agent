/**
 * `birdybeep doctor` (§9.4, §21.1–21.2) — the self-service troubleshooter. Runs a battery
 * of checks (machine token, each adapter's doctor() incl. needs_trust/needs_restart/error,
 * local queue health, backend reachability), prints a concrete copy-pasteable fix for each
 * failure, drains the queue opportunistically, and exits non-zero when anything fails so
 * it's CI/script friendly. Read-only (never mutates harness config); never prints token
 * material or notification bodies. `--json` mirrors all findings.
 */
import {
  type AgentAdapter,
  createSender as defaultCreateSender,
  type Sender,
  type TokenStoreOptions,
} from "@birdybeep/agent-core";
import { claudeCodeAdapter } from "@birdybeep/claude-code";
import { codexAdapter } from "@birdybeep/codex";
import { cursorAdapter } from "@birdybeep/cursor";
import { opencodeAdapter } from "@birdybeep/opencode";

import { resolveApiUrl } from "../config";
import { isPaired, localQueueDepth } from "../diagnostics";
import { type Command, EXIT } from "../framework";

const DEFAULT_ADAPTERS: AgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
  cursorAdapter,
];

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  remedy?: string;
}

/** Best-effort backend reachability probe (HEAD; any non-5xx response = reachable). */
async function defaultProbeNetwork(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    if (typeof timer.unref === "function") timer.unref();
    const res = await fetch(baseUrl, { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);
    return res.status < 500;
  } catch {
    return false;
  }
}

export interface DoctorCommandDeps {
  adapters?: AgentAdapter[];
  createSender?: (baseUrl: string) => Sender;
  tokenOptions?: TokenStoreOptions;
  /** Backend reachability probe (tests inject reachable/unreachable). */
  probeNetwork?: (baseUrl: string) => Promise<boolean>;
}

export function createDoctorCommand(deps: DoctorCommandDeps = {}): Command {
  const adapters = deps.adapters ?? DEFAULT_ADAPTERS;
  const probeNetwork = deps.probeNetwork ?? defaultProbeNetwork;
  const makeSender =
    deps.createSender ??
    ((baseUrl) =>
      defaultCreateSender(
        deps.tokenOptions ? { baseUrl, tokenOptions: deps.tokenOptions } : { baseUrl },
      ));

  return {
    name: "doctor",
    summary: "Diagnose token, trust, restart, and offline-queue issues",
    usage: "birdybeep doctor [--json]",
    run: async (ctx) => {
      const checks: Check[] = [];
      const apiUrl = resolveApiUrl();

      // 1. Machine token.
      const paired = await isPaired(deps.tokenOptions ?? {});
      checks.push(
        paired
          ? { name: "Machine token", ok: true }
          : {
              name: "Machine token",
              ok: false,
              detail: "No machine token found.",
              remedy: "Run `birdybeep pair` to pair this machine.",
            },
      );

      // 2. Each adapter's own diagnostics (detected? installed? needs_trust/needs_restart/error?).
      for (const adapter of adapters) {
        const result = await adapter.doctor();
        for (const c of result.checks) {
          checks.push({
            name: `${adapter.displayName}: ${c.name}`,
            ok: c.ok,
            ...(c.detail !== undefined ? { detail: c.detail } : {}),
            ...(c.remedy !== undefined ? { remedy: c.remedy } : {}),
          });
        }
      }

      // 3. Local queue: drain opportunistically, report depth.
      const depthBefore = localQueueDepth();
      const drain = await makeSender(apiUrl).drainNow();
      const depthAfter = localQueueDepth();
      checks.push({
        name: "Local queue",
        ok: true,
        detail: `${depthBefore} queued → ${drain.delivered} delivered, ${depthAfter} remaining`,
      });

      // 4. Backend reachability.
      const reachable = await probeNetwork(apiUrl);
      checks.push(
        reachable
          ? { name: "Backend reachable", ok: true }
          : {
              name: "Backend reachable",
              ok: false,
              detail: `Could not reach ${apiUrl}.`,
              remedy: "Check your network; queued events will retry automatically.",
            },
      );

      const ok = checks.every((c) => c.ok);

      if (ctx.flags.json) {
        ctx.io.result({
          ok,
          checks,
          queue: { depthBefore, delivered: drain.delivered, depthAfter },
        });
      } else {
        for (const c of checks) {
          ctx.io.line(`${c.ok ? "✓" : "✗"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
          if (!c.ok && c.remedy) ctx.io.line(`     → ${c.remedy}`);
        }
        ctx.io.line(ok ? "\nAll checks passed." : "\nSome checks failed — see fixes above.");
      }
      return ok ? EXIT.OK : EXIT.ERROR;
    },
  };
}
