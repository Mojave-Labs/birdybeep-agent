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
    summary: "Manage events waiting to retry",
    helpGroup: "Manage",
    examples: ["birdybeep status", "birdybeep queue clear"],
    usage: "birdybeep queue <clear>",
    subcommands: [
      {
        name: "clear",
        summary: "Discard events waiting to retry",
        examples: ["birdybeep queue clear"],
        positionalArgs: 0,
        usage: "birdybeep queue clear",
        run: (ctx) => {
          const cleared = new LocalEventQueue().clear();
          ctx.io.emit(
            cleared === 0
              ? "Queue is empty. Nothing to clear."
              : `Discarded ${cleared} queued event${cleared === 1 ? "" : "s"}.`,
            { cleared },
          );
          return EXIT.OK;
        },
      },
    ],
  };
}
