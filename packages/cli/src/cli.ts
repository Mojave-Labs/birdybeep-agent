/**
 * @birdybeep/cli — argument handling, kept side-effect-free so it is unit-testable.
 * The bin entry (`bin.ts`) is the only place that touches `process.argv`/exit.
 *
 * This is the A-MONOREPO scaffold: it wires a runnable `--help`/`--version` shell
 * and advertises the command surface. The real commands (login, logout, status,
 * test, doctor, agent install/uninstall, hook) land in the a-cli epic tickets.
 */

/** CLI version marker — replaced by the real build/version pipeline (REL-*). */
export const CLI_VERSION = "0.0.0";

const USAGE = `birdybeep ${CLI_VERSION} — stream coding-agent lifecycle events to BirdyBeep.

Usage:
  birdybeep <command> [options]

Commands (coming soon — not yet implemented in this scaffold):
  login                 Pair this machine with your BirdyBeep account (QR or manual)
  logout                Remove the local machine token
  status                Show pairing + per-harness integration status
  test                  Send a test event end-to-end
  doctor                Diagnose token, trust, restart, and offline-queue issues
  agent install [name]  Install adapters (all | claude | codex | opencode)
  agent uninstall [name]  Restore harness config to its pre-install state
  hook <harness>        Internal: invoked by a harness hook to normalize + send an event

Options:
  -h, --help            Show this help
  -v, --version         Show the CLI version`;

/** Render the top-level help/usage text. */
export function renderHelp(): string {
  return USAGE;
}

/**
 * Run the CLI against an argv slice (without `node`/script path).
 * Returns the intended process exit code. Pure except for stdout/stderr writes.
 */
export function run(argv: string[]): number {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${renderHelp()}\n`);
    return 0;
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  process.stderr.write(
    `birdybeep: "${argv.join(" ")}" is not implemented yet. Run \`birdybeep --help\`.\n`,
  );
  return 1;
}
