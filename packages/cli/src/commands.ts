/**
 * The `birdybeep` command registry (§9.4) — the command tree the framework dispatches.
 * Every command is a factory (`create*Command`) so its dependencies (adapters, sender,
 * token store, fetch, stdin) are injectable for hermetic tests; the framework (help /
 * flags / routing / config dir / exit codes) is command-independent.
 */
import { createAgentCommand } from "./commands/agent";
import { createDoctorCommand } from "./commands/doctor";
import { createHookCommand } from "./commands/hook";
import { createLogoutCommand, createUnpairCommand } from "./commands/logout";
import { createPairCommand, createSetupCommand } from "./commands/pair";
import { createQueueCommand } from "./commands/queue";
import { createReportStatusCommand } from "./commands/report-status";
import { createStatusCommand } from "./commands/status";
import { createTestCommand } from "./commands/test";
import { type Command } from "./framework";

/**
 * Build the full §9.4 command tree.
 *
 * `setup` leads (gcgp.5) — the root help lists these in registry order, and the first entry is
 * what a new reader tries. It and `pair` run the identical flow; `setup` is the verb people look
 * for, and the only one that skips the phone round-trip on a machine that already has a token.
 */
export function buildCommands(): Command[] {
  return [
    createSetupCommand(),
    createPairCommand(),
    createLogoutCommand(),
    createUnpairCommand(),
    createStatusCommand(),
    createTestCommand(),
    createDoctorCommand(),
    createAgentCommand(),
    createHookCommand(),
    createQueueCommand(),
    createReportStatusCommand(),
  ];
}
