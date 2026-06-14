/**
 * Shared status/queue plumbing used by `birdybeep status` and `birdybeep doctor`: gather
 * each adapter's integration status, the machine identity + login state, and local queue
 * depth. Read-only + privacy-safe — never prints token material or notification bodies.
 */
import {
  type AgentAdapter,
  getMachineIdentity,
  getToken,
  type IntegrationStatus,
  LocalEventQueue,
  type TokenStoreOptions,
} from "@birdybeep/agent-core";

export interface IntegrationState {
  harness: string;
  displayName: string;
  status: IntegrationStatus;
}

/** Each adapter's current §8.8 integration status (runs the real adapter.status()). */
export async function gatherIntegrations(adapters: AgentAdapter[]): Promise<IntegrationState[]> {
  return Promise.all(
    adapters.map(async (a) => ({
      harness: a.id,
      displayName: a.displayName,
      status: await a.status(),
    })),
  );
}

/** Is a machine token present in the secure store? (login state — never prints the token.) */
export async function isLoggedIn(tokenOptions: TokenStoreOptions = {}): Promise<boolean> {
  return (await getToken(tokenOptions)) !== null;
}

/** Current local event-queue depth (fresh, non-expired entries). */
export function localQueueDepth(): number {
  return new LocalEventQueue().size();
}

/** Machine label + OS (the event `machine` identity). */
export function machineIdentity(): { label: string; os: string } {
  return getMachineIdentity();
}
