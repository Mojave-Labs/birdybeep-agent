---
"@birdybeep/agent-core": patch
"@birdybeep/cli": patch
---

Mirror the two newly-formalized backend RESPONSE schemas into `agent-core` so the CLI has
typed, runtime-validated responses (the agent-core half of product birdybeep-kje4 / #51).
**The wire is unchanged** — the worker already emits exactly these shapes; this only pins
the type and structure on the agent side so a future drift is caught by the cross-repo guard.

- `agent-core/event.ts`: add `agentEventsResponseSchema` (`{ accepted, decision }`) +
  `agentEventDecisionSchema` / `AGENT_EVENT_ACCEPT_DECISIONS` (`notified` / `deduped` /
  `suppressed` — the accept-path subset; `rate_limited` / `quota_rejected` remain 429 error
  envelopes, never this shape), mirrored field-for-field from the product `packages/schemas`.
- `agent-core/integrations.ts`: bring `integrationStatusResponseSchema` into exact lockstep —
  factor out `integrationStatusResultSchema` (`{ harness, status, updated }`) with `updated`
  now **required** (previously omitted + `.catchall`-tolerated), matching the formalized
  product contract.
- The sender now surfaces the 202 delivery decision by validating the accept body against
  `agentEventsResponseSchema` instead of a loose hand-rolled field read, so an off-contract
  body no longer surfaces a bogus decision. No behavior change on the real wire.
