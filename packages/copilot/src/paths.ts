/** GitHub Copilot CLI user-hook paths, respecting COPILOT_HOME when configured. */
import { homedir } from "node:os";
import { join } from "node:path";

export const COPILOT_DIR_NAME = ".copilot";
export const COPILOT_HOOKS_DIR_NAME = "hooks";
export const BIRDYBEEP_HOOKS_FILE = "birdybeep.json";

export interface CopilotPathOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** Copilot's configuration home (`COPILOT_HOME`, otherwise `~/.copilot`). */
export function copilotConfigDir(options: CopilotPathOptions = {}): string {
  const configured = (options.env ?? process.env)["COPILOT_HOME"];
  if (configured !== undefined && configured.trim().length > 0) return configured;
  return join(options.home ?? homedir(), COPILOT_DIR_NAME);
}

export function copilotHooksDir(options: CopilotPathOptions = {}): string {
  return join(copilotConfigDir(options), COPILOT_HOOKS_DIR_NAME);
}

/** Dedicated BirdyBeep hook file; foreign Copilot hook files are never read or modified. */
export function copilotHooksPath(options: CopilotPathOptions = {}): string {
  return join(copilotHooksDir(options), BIRDYBEEP_HOOKS_FILE);
}
