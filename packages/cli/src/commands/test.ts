/**
 * `birdybeep test` (§7.1, §9.4) — send a representative test event through the REAL sender
 * path (normalize/redact/truncate → send w/ short timeout → queue-on-fail → opportunistic
 * drain) so a developer can confirm end-to-end delivery (and trigger a test Beep) right
 * after pairing. Not a mock — it exercises the production code path. Reports delivered vs
 * NOT PAIRED vs queued vs rejected, and for a queued event which of the three causes parked it
 * (offline / the backend asked for a retry / the token store would not answer); --json mirrors
 * the outcome and the cause.
 *
 * Sends event_type "test" (9fh): the backend notifies it by default. (The old "custom" type is
 * unconditionally suppressed by the §10.5 matrix — every test "succeeded" while no push could
 * ever be sent.) It is METERED like any other event on this route — the quota exemption was
 * removed backend-side because event_type is client-controlled and an exemption keyed on it was
 * a bypass — so a `test` on an exhausted account is rejected, and says so (58l). The session id
 * is unique per run so back-to-back tests don't collapse in the backend's dedupe window, and the
 * CLI reports the backend's actual DECISION instead of assuming a beep.
 */
import { randomUUID } from "node:crypto";

import {
  type BirdyBeepAgentEvent,
  createSender as defaultCreateSender,
  fetchPushReachability,
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
  /** fetch used by the push-reachability read (injected in tests). */
  fetchImpl?: typeof fetch;
  /**
   * Base URL for BOTH the send and the reachability read. One value on purpose: injecting a
   * sender that points at a stub while the reachability read still resolved the REAL API would
   * make tests reach the network, and would report on a different account than the one under test.
   */
  baseUrl?: string;
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
      const baseUrl = deps.baseUrl ?? resolveApiUrl();
      const result = await makeSender(baseUrl).send(event); // real path; also drains the queue

      if (ctx.flags.json) {
        ctx.io.result({
          outcome: result.outcome,
          ...(result.status ? { status: result.status } : {}),
          ...(result.decision ? { decision: result.decision } : {}),
          ...(result.queueCause ? { queueCause: result.queueCause } : {}),
          ...(result.tokenStoreUnavailable !== undefined
            ? { tokenStore: "unavailable", tokenStoreReason: result.tokenStoreUnavailable.reason }
            : {}),
        });
      } else if (result.outcome === "delivered") {
        // The 202 body says what the backend DECIDED — "delivered" alone only means
        // "accepted". Claiming a beep that was suppressed is how 9fh went unnoticed.
        if (result.decision === "notified" || result.decision === undefined) {
          // "delivered" means the BACKEND accepted it and enqueued a push. It says nothing about
          // whether a device exists to receive one — and this line used to promise a Beep on a
          // machine whose account had no reachable device at all, which is precisely the state
          // that took hours to find (birdybeep-agent-oi3). Ask, and say what is true.
          const reach = await fetchPushReachability({
            baseUrl,
            ...(deps.tokenOptions ? { tokenOptions: deps.tokenOptions } : {}),
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          });
          if (reach.state === "ok" && reach.data.active_device_count === 0) {
            ctx.io.line(
              "⚠ The backend accepted the test event, but NO device on this account can receive " +
                "it — nothing will arrive. Open the BirdyBeep app on your phone to register it " +
                "(if it says the device limit is full, free a slot in Settings › devices).",
            );
          } else if (reach.state === "ok") {
            ctx.io.line(
              `✓ Test event accepted and queued for ${String(reach.data.active_device_count)} ` +
                "registered device(s) — check your phone for a test Beep.",
            );
          } else {
            // Could not ask. Do not upgrade that into a promise.
            ctx.io.line("✓ Test event accepted by the backend — check your phone for a test Beep.");
          }
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
      } else if (result.outcome === "unpaired") {
        // gcgp.4: this said "Offline — test event queued" on a machine that was online and
        // merely unpaired, and exited 0. `test` is the one command whose entire job is to tell
        // you why beeps aren't arriving; naming the wrong cause is worse than saying nothing.
        ctx.io.line(
          "✗ NOT PAIRED — this machine has no BirdyBeep machine token, so nothing was sent " +
            "(and nothing was queued). Run `birdybeep pair`.",
        );
      } else if (result.tokenStoreUnavailable !== undefined) {
        // gcgp.23: the machine is online and may well be paired — the token store just would
        // not answer, so neither "Offline" nor "NOT PAIRED" names the real cause.
        ctx.io.line(
          `• Could not read the machine token (${result.tokenStoreUnavailable.reason}) — the ` +
            "test event was queued and delivers once the token store is readable. If your " +
            "keychain is locked, unlock it and run `birdybeep test` again.",
        );
      } else if (result.outcome === "queued" && result.queueCause === "backend") {
        // 0yk: rate_limited / internal_error / any 5xx also queue, and this branch used to send
        // the user off to debug a network that had just carried the request to the backend and
        // back. Name what answered, and say the retry is automatic.
        const status = result.status !== undefined ? ` (HTTP ${String(result.status)})` : "";
        ctx.io.line(
          result.code === "rate_limited" || result.status === 429
            ? `• Throttled by the backend${status} — test event queued; it retries on its own. ` +
                "Not your network: the request got through."
            : `• The backend is having trouble${status} — test event queued; it retries on its ` +
                "own. Not your network: the request got through.",
        );
      } else if (result.outcome === "queued") {
        ctx.io.line("• Offline — test event queued; it will deliver when you reconnect.");
      } else if (result.code === "quota_exceeded") {
        // 58l: "rejected by the backend" named nothing. The error envelope says WHICH rejection
        // this is, and the reachability read carries the account's meter — so name the cause and
        // the date it clears. Everything printed here comes off the wire; when the server is old
        // enough not to report quota, the sentence stops at what the error code proves.
        const reach = await fetchPushReachability({
          baseUrl,
          ...(deps.tokenOptions ? { tokenOptions: deps.tokenOptions } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
        const quota = reach.state === "ok" ? reach.data.quota : undefined;
        ctx.io.line(
          quota
            ? `✗ Test event REJECTED — this account's monthly beep quota is used up ` +
                `(${String(quota.beeps_accepted)}/${String(quota.beeps_limit)} beeps on the ` +
                `${quota.plan} plan, period ${quota.period_start.slice(0, 10)} → ` +
                `${quota.period_end.slice(0, 10)}). Every notifiable event is being rejected ` +
                `until it resets on ${quota.period_end.slice(0, 10)} — or upgrade to Plus in the ` +
                "BirdyBeep app."
            : "✗ Test event REJECTED — this account's monthly beep quota is used up, so no beep " +
                "can be sent. Run `birdybeep doctor` for the period and the reset date.",
        );
      } else {
        ctx.io.line("✗ Test event was rejected by the backend. Run `birdybeep doctor`.");
      }

      // delivered + queued are non-failure (offline is by design, and so is a store that is
      // momentarily unreadable — the event is parked, not lost). A hard reject is an error —
      // and so is being unpaired, which sent nothing at all (`status` already exits non-zero
      // for it, so a script can branch on either command).
      return result.outcome === "dropped" || result.outcome === "unpaired" ? EXIT.ERROR : EXIT.OK;
    },
  };
}
