/**
 * `birdybeep queue clear` (§9.4) — debug maintenance: drop all locally-queued events. The
 * queue is best-effort (≤24h retention), so clearing it only discards pending retries; it
 * never touches harness config or the token. Reports how many entries were removed.
 */
import { LocalEventQueue } from "@birdybeep/agent-core";

import { type Command, EXIT } from "../framework";

export function createQueueCommand(): Command {
  return {
    name: "queue",
    summary: "Local event-queue maintenance",
    usage: "birdybeep queue <clear>",
    subcommands: [
      {
        name: "clear",
        summary: "Clear the local offline event queue (debug)",
        usage: "birdybeep queue clear",
        run: (ctx) => {
          const cleared = new LocalEventQueue().clear();
          ctx.io.emit(`Cleared ${cleared} queued event(s).`, { cleared });
          return EXIT.OK;
        },
      },
    ],
  };
}
