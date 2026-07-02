/**
 * `birdybeep test` (§7.1, §9.4) — send a representative test event through the REAL sender
 * path (normalize/redact/truncate → send w/ short timeout → queue-on-fail → opportunistic
 * drain) so a developer can confirm end-to-end delivery (and trigger a test Beep) right
 * after pairing. Not a mock — it exercises the production code path. Reports delivered vs
 * queued (offline) vs rejected; --json mirrors the outcome.
 *
 * Sends event_type "test" (9fh): the backend notifies it by default and exempts it from
 * the beep quota. (The old "custom" type is unconditionally suppressed by the §10.5
 * matrix — every test "succeeded" while no push could ever be sent.) The session id is
 * unique per run so back-to-back tests don't collapse in the backend's dedupe window,
 * and the CLI reports the backend's actual DECISION instead of assuming a beep.
 */
import { randomUUID } from "node:crypto";

import {
  type BirdyBeepAgentEvent,
  createSender as defaultCreateSender,
  getMachineIdentity,
  normalizeEvent,
  type NormalizeOptions,
  type Sender,
  type TokenStoreOptions,
} from "@birdybeep/agent-core";

import { resolveApiUrl } from "../config";
import { type Command, EXIT } from "../framework";

/** Build the canonical test event (event_type `test`, unique session per run). cwd is hashed by the normalizer. */
export function buildTestEvent(opts: NormalizeOptions = {}): BirdyBeepAgentEvent {
  const machine = getMachineIdentity();
  return normalizeEvent(
    {
      event_type: "test",
      status: "running",
      harness: "claude_code", // schema requires a harness; the "test" type distinguishes it
      // Unique per run: a repeat `birdybeep test` inside the backend's dedupe window must
      // still beep — a constant id made the second test silently "deduped" (9fh).
      source_session_id: `birdybeep-cli-test-${randomUUID()}`,
      machine: { label: machine.label, os: machine.os },
      workspace: { cwd: process.cwd() },
      title: "BirdyBeep test event",
      body: "If you can see this, your machine is wired up correctly.",
      metadata: { test: true },
    },
    opts,
  );
}

export interface TestCommandDeps {
  createSender?: (baseUrl: string) => Sender;
  tokenOptions?: TokenStoreOptions;
}

export function createTestCommand(deps: TestCommandDeps = {}): Command {
  const makeSender =
    deps.createSender ??
    ((baseUrl) =>
      defaultCreateSender(
        deps.tokenOptions ? { baseUrl, tokenOptions: deps.tokenOptions } : { baseUrl },
      ));

  return {
    name: "test",
    summary: "Send a test event end-to-end",
    usage: "birdybeep test [--json]",
    run: async (ctx) => {
      const event = buildTestEvent();
      const result = await makeSender(resolveApiUrl()).send(event); // real path; also drains the queue

      if (ctx.flags.json) {
        ctx.io.result({
          outcome: result.outcome,
          ...(result.status ? { status: result.status } : {}),
          ...(result.decision ? { decision: result.decision } : {}),
        });
      } else if (result.outcome === "delivered") {
        // The 202 body says what the backend DECIDED — "delivered" alone only means
        // "accepted". Claiming a beep that was suppressed is how 9fh went unnoticed.
        if (result.decision === "notified" || result.decision === undefined) {
          ctx.io.line("✓ Test event delivered — check your phone for a test Beep.");
        } else if (result.decision === "suppressed") {
          ctx.io.line(
            "⚠ The backend accepted the test event but suppressed the push — this machine " +
              "or integration is probably muted. Check mutes in the app, or run `birdybeep doctor`.",
          );
        } else if (result.decision === "deduped") {
          ctx.io.line(
            "⚠ The backend accepted the test event but folded it into a recent duplicate — " +
              "wait ~30s and run `birdybeep test` again.",
          );
        } else {
          ctx.io.line(
            `⚠ The backend accepted the test event but decided "${result.decision}" — no push ` +
              "was sent. Run `birdybeep doctor`.",
          );
        }
      } else if (result.outcome === "queued") {
        ctx.io.line("• Offline — test event queued; it will deliver when you reconnect.");
      } else {
        ctx.io.line("✗ Test event was rejected by the backend. Run `birdybeep doctor`.");
      }

      // delivered + queued are non-failure (offline is by design); a hard reject is an error.
      return result.outcome === "dropped" ? EXIT.ERROR : EXIT.OK;
    },
  };
}
