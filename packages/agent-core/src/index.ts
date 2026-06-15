/**
 * @birdybeep/agent-core — the shared runtime every adapter and the CLI build on:
 * the canonical event schema (kept in lockstep with the private product repo's
 * `packages/schemas`), the normalizer/redaction layer, the 24h local queue, the
 * sender, the machine token store, and the `AgentAdapter` interface.
 *
 * The canonical event schema + enums (CORE-SCHEMA) are exported below. The
 * normalizer/queue/sender/token-store/adapter-interface land in the remaining
 * agent-core epic (CORE-*) tickets — see `bd ready`.
 */
export * from "./adapter";
export * from "./api";
export * from "./dedup";
export * from "./event";
export * from "./fingerprint";
export * from "./hook";
export * from "./integrations";
export * from "./normalize";
export * from "./pairing";
export * from "./paths";
export * from "./primitives";
export * from "./queue";
export * from "./sender";
export * from "./token-store";

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
