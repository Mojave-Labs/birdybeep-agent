/**
 * @birdybeep/codex — the Codex adapter (one-time `/hooks` trust).
 *
 * Placeholder for the A-MONOREPO scaffold. Codex is not considered "installed"
 * until the first event arrives after the user trusts the hooks once; the adapter
 * surfaces that as `needs_trust`. Real install/notify/hook/normalize logic lands
 * in the a-codex epic tickets.
 */
import { type AdapterMeta } from "@birdybeep/agent-core";

/** Stable BirdyBeep harness id for Codex (§9.6). */
export const CODEX_HARNESS_ID = "codex";

/** Adapter identity, typed against agent-core's shared shape. */
export const codexMeta: AdapterMeta = { harness: CODEX_HARNESS_ID };
