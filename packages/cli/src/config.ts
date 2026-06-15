/**
 * Non-secret CLI config (§9.4): a small `config.json` in the BirdyBeep user config dir
 * holding things like the API base URL. The machine TOKEN never lives here — it is read
 * exclusively from the secure token store (keychain / strict-perm file). Tolerant readers:
 * a missing/corrupt config falls back to defaults rather than crashing the hot path.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { birdyBeepConfigDir } from "@birdybeep/agent-core";

/** Default backend base URL (overridable via env or `birdybeep login`; finalized in a-release). */
export const DEFAULT_API_URL = "https://api.birdybeep.dev";
export const CONFIG_FILE = "config.json";

export interface CliConfig {
  /** Backend base URL (set by `login`); never holds a token. */
  apiUrl?: string;
}

export function cliConfigPath(): string {
  return join(birdyBeepConfigDir(), CONFIG_FILE);
}

/** Read the CLI config; returns `{}` on a missing/unreadable/corrupt file (never throws). */
export function readCliConfig(): CliConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cliConfigPath(), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge + persist non-secret CLI config (strict-perm dir). Only the KNOWN non-secret keys
 * are ever written — anything else (e.g. a token someone passed by mistake) is dropped, so
 * the token can only ever live in the secure store, never here.
 */
export function writeCliConfig(patch: CliConfig): void {
  const current = readCliConfig();
  const merged: CliConfig = {};
  const apiUrl = patch.apiUrl ?? current.apiUrl;
  if (apiUrl !== undefined) merged.apiUrl = apiUrl;
  mkdirSync(birdyBeepConfigDir(), { recursive: true, mode: 0o700 });
  writeFileSync(cliConfigPath(), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
}

/** Resolve the backend base URL: `BIRDYBEEP_API_URL` env → CLI config → default. */
export function resolveApiUrl(): string {
  const env = process.env["BIRDYBEEP_API_URL"];
  if (env !== undefined && env.length > 0) return env;
  return readCliConfig().apiUrl ?? DEFAULT_API_URL;
}
