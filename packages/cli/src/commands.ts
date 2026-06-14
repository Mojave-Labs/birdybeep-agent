/**
 * The `birdybeep` command registry (§9.4) — the command tree the framework dispatches.
 * Every command is a factory (`create*Command`) so its dependencies (adapters, sender,
 * token store, fetch, stdin) are injectable for hermetic tests; the framework (help /
 * flags / routing / config dir / exit codes) is command-independent.
 */
import { createAgentCommand } from "./commands/agent";
import { createDoctorCommand } from "./commands/doctor";
import { createHookCommand } from "./commands/hook";
import { createLoginCommand } from "./commands/login";
import { createLogoutCommand } from "./commands/logout";
import { createQueueCommand } from "./commands/queue";
import { createReportStatusCommand } from "./commands/report-status";
import { createStatusCommand } from "./commands/status";
import { createTestCommand } from "./commands/test";
import { type Command } from "./framework";

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
    createReportStatusCommand(),
  ];
}
