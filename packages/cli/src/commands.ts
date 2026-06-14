/**
 * The `birdybeep` command registry (§9.4) — the command tree the framework dispatches.
 * Each command's real logic lands in its own a-cli ticket and replaces the stub here;
 * the framework (help / flags / routing / config dir / exit codes) is ticket-independent.
 */
import { createAgentCommand } from "./commands/agent";
import { createDoctorCommand } from "./commands/doctor";
import { createHookCommand } from "./commands/hook";
import { createLoginCommand } from "./commands/login";
import { createLogoutCommand } from "./commands/logout";
import { createQueueCommand } from "./commands/queue";
import { createStatusCommand } from "./commands/status";
import { createTestCommand } from "./commands/test";
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
    createLoginCommand(),
    createLogoutCommand(),
    createStatusCommand(),
    createTestCommand(),
    createDoctorCommand(),
    createAgentCommand(),
    createHookCommand(),
    createQueueCommand(),
    {
      name: "report-status",
      summary: "Internal: report integration status to the backend",
      usage: "birdybeep report-status",
      run: stub("birdybeep-agent-7il"),
    },
  ];
}
