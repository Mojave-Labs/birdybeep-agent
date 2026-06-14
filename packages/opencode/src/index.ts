/**
 * @birdybeep/opencode — the OpenCode adapter (plugin).
 *
 * Placeholder for the A-MONOREPO scaffold. OpenCode loads its plugin only after a
 * restart, so the adapter surfaces `needs_restart` until the plugin is live. Real
 * plugin/install/normalize logic lands in the a-opencode epic tickets.
 */
import { type AdapterMeta } from "@birdybeep/agent-core";

/** Stable BirdyBeep harness id for OpenCode (§9.7). */
export const OPENCODE_HARNESS_ID = "opencode";

/** Adapter identity, typed against agent-core's shared shape. */
export const opencodeMeta: AdapterMeta = { harness: OPENCODE_HARNESS_ID };
