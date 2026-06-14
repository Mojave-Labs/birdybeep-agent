/**
 * @birdybeep/agent-core — the shared runtime every adapter and the CLI build on:
 * the canonical event schema (kept in lockstep with the private product repo's
 * `packages/schemas`), the normalizer/redaction layer, the 24h local queue, the
 * sender, the machine token store, and the `AgentAdapter` interface.
 *
 * This file is an intentional placeholder for the A-MONOREPO scaffold: it ships a
 * stable version marker and a minimal adapter-meta shape so the workspace builds,
 * type-checks, and proves cross-package imports. Real schema/queue/sender/token
 * logic lands in the agent-core epic (CORE-*) tickets — see `bd ready`.
 */

/** Package version marker — replaced by the real build/version pipeline (REL-*). */
export const AGENT_CORE_VERSION = "0.0.0";

/**
 * Minimal identity an adapter reports about the harness it integrates with.
 * The full {@link https://birdybeep.dev | AgentAdapter} interface (detect /
 * install / uninstall / status / doctor / normalizeEvent) is defined in CORE-ADAPTER.
 */
export interface AdapterMeta {
  /** Stable harness id, e.g. `"claude_code"`, `"codex"`, `"opencode"`. */
  readonly harness: string;
}

// TEMPORARY — A-CI gate-bites proof. Deliberate TS2322 type error to confirm CI
// turns red. This lives only on the throwaway ci/gate-bites-proof branch.
export const CI_GATE_PROOF: number = "this is not a number";
