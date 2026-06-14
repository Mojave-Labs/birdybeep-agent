/**
 * The `birdybeep` command registry (§9.4) — the command tree the framework dispatches.
 * Each command's real logic lands in its own a-cli ticket and replaces the stub here;
 * the framework (help / flags / routing / config dir / exit codes) is ticket-independent.
 */
import { createAgentCommand } from "./commands/agent";
import { createHookCommand } from "./commands/hook";
import { type Command, type CommandContext, EXIT } from "./framework";

/** Placeholder run for a command whose logic lands in a later ticket. */
function stub(ticket: string): (ctx: CommandContext) => number {
  return (ctx) => {
    ctx.io.errline(`birdybeep: this command is not implemented yet (${ticket}).`);
    return EXIT.ERROR;
  };
}

/** Build the full §9.4 command tree. */
export function buildCommands(): Command[] {
  return [
    {
      name: "login",
      summary: "Pair this machine with your BirdyBeep account (QR or manual)",
      usage: "birdybeep login [--code <pairing-code>]",
      run: stub("birdybeep-agent-v2h"),
    },
    {
      name: "logout",
      summary: "Remove the local machine token",
      usage: "birdybeep logout",
      run: stub("birdybeep-agent-1ev"),
    },
    {
      name: "status",
      summary: "Show pairing + per-harness integration status",
      usage: "birdybeep status [--json]",
      run: stub("birdybeep-agent-b64"),
    },
    {
      name: "test",
      summary: "Send a test event end-to-end",
      usage: "birdybeep test",
      run: stub("birdybeep-agent-msn"),
    },
    {
      name: "doctor",
      summary: "Diagnose token, trust, restart, and offline-queue issues",
      usage: "birdybeep doctor [--json]",
      run: stub("birdybeep-agent-dxl"),
    },
    createAgentCommand(),
    createHookCommand(),
    {
      name: "queue",
      summary: "Local event-queue maintenance",
      usage: "birdybeep queue <clear>",
      subcommands: [
        {
          name: "clear",
          summary: "Clear the local offline event queue (debug)",
          usage: "birdybeep queue clear",
          run: stub("birdybeep-agent-zrj"),
        },
      ],
    },
    {
      name: "report-status",
      summary: "Internal: report integration status to the backend",
      usage: "birdybeep report-status",
      run: stub("birdybeep-agent-7il"),
    },
  ];
}
