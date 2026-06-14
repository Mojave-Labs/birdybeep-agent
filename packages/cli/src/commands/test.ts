/**
 * `birdybeep test` (§7.1, §9.4) — send a representative test event through the REAL sender
 * path (normalize/redact/truncate → send w/ short timeout → queue-on-fail → opportunistic
 * drain) so a developer can confirm end-to-end delivery (and trigger a test Beep) right
 * after pairing. Not a mock — it exercises the production code path. Reports delivered vs
 * queued (offline) vs rejected; --json mirrors the outcome.
 */
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

/** Build the canonical test event (event_type `custom`, marked `test`). cwd is hashed by the normalizer. */
export function buildTestEvent(opts: NormalizeOptions = {}): BirdyBeepAgentEvent {
  const machine = getMachineIdentity();
  return normalizeEvent(
    {
      event_type: "custom",
      status: "running",
      harness: "claude_code", // schema requires a harness; the test marker distinguishes it
      source_session_id: "birdybeep-cli-test",
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
        });
      } else if (result.outcome === "delivered") {
        ctx.io.line("✓ Test event delivered — check your phone for a test Beep.");
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
