/**
 * Passive update notifier (§9.4). Instead of a manual `update` command, the CLI opportunistically
 * checks the npm registry for a newer `@birdybeep/cli` and prints a subtle "new version available"
 * notice to **stderr** after an eligible command runs — so users learn about upgrades just by using
 * the tool. It is:
 *
 *  - **Cached (TTL-gated):** the result is stored in the config dir and only refreshed from the
 *    network once per {@link DEFAULT_CHECK_INTERVAL_MS}; every other run is a local file read.
 *  - **Non-blocking to the hot path:** the `hook` command (which runs inside the harness and must
 *    return fast) and the internal `report-status` command are skipped before any I/O.
 *  - **Quiet for machines/scripts:** skipped under `--json`, `--non-interactive`, a non-TTY stderr,
 *    `CI`, or the `NO_UPDATE_NOTIFIER` / `BIRDYBEEP_NO_UPDATE_NOTIFIER` opt-outs.
 *  - **Best-effort & side-effect-free on the result:** it never throws, never changes stdout, and
 *    never affects the command's exit code (registry/semver logic lives here, not in the framework).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { birdyBeepConfigDir } from "@birdybeep/agent-core";

import { resolveRegistryUrl } from "./config";
import { type GlobalFlags, type Io } from "./framework";
import { CLI_VERSION } from "./version";

/** The published package the notice points at. */
export const PACKAGE_NAME = "@birdybeep/cli";
/** URL-encoded scoped path for the registry `latest` dist-tag endpoint. */
const PACKAGE_PATH = "@birdybeep%2Fcli";
/** Cache file (non-secret) in the BirdyBeep config dir. */
export const UPDATE_CACHE_FILE = "update-check.json";
/** Refresh the registry at most once per this window; every other run reads the cache. */
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
/** Best-effort timeout for the (rare) registry refresh — short so it can't stall a command. */
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Top-level commands that must never trigger a check/notice:
 *  - `hook` runs inside the harness hot path and must return fast (never block the harness);
 *  - `report-status` is invoked by BirdyBeep itself, not by an interactive user.
 */
const SKIP_COMMANDS = new Set(["hook", "report-status"]);

/** A parsed semver: numeric core + dot-separated prerelease identifiers (build metadata dropped). */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers (e.g. `1.2.0-beta.1` → `["beta", "1"]`); empty for a release. */
  prerelease: string[];
}

// Simplified semver.org grammar: `MAJOR.MINOR.PATCH[-prerelease][+build]`, tolerating a leading `v`.
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a semver string; returns null for anything that isn't a clean `MAJOR.MINOR.PATCH[...]`. */
export function parseSemver(input: string): Semver | null {
  const m = SEMVER_RE.exec(input.trim());
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] !== undefined ? m[4].split(".") : [],
  };
}

/** Compare two prerelease identifier lists per semver §11 (a release outranks any prerelease). */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 1.2.0 > 1.2.0-beta
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (aNum) {
      return -1; // numeric identifiers rank lower than alphanumeric
    } else if (bNum) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1; // ASCII lexical order
    }
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1; // more identifiers wins when all preceding are equal
}

/** -1 if `a < b`, 0 if equal, 1 if `a > b` (semver precedence). */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** `true` when `latest` is a strictly higher version than `current` (both must parse). */
export function isNewer(current: string, latest: string): boolean {
  const cur = parseSemver(current);
  const lat = parseSemver(latest);
  return cur !== null && lat !== null && compareSemver(cur, lat) < 0;
}

/** Cached registry result. `latest` is the last-seen published version, or null if never fetched. */
export interface UpdateCache {
  /** Epoch ms of the last registry refresh attempt. */
  checkedAt: number;
  latest: string | null;
}

export function updateCachePath(): string {
  return join(birdyBeepConfigDir(), UPDATE_CACHE_FILE);
}

/** Read the cache; returns null on a missing/unreadable/corrupt/invalid file (never throws). */
export function readUpdateCache(): UpdateCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(updateCachePath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { checkedAt, latest } = parsed as Record<string, unknown>;
    if (typeof checkedAt !== "number") return null;
    if (latest !== null && typeof latest !== "string") return null;
    return { checkedAt, latest };
  } catch {
    return null;
  }
}

/** Persist the cache (strict-perm dir + file); best-effort — a write failure is swallowed by callers. */
export function writeUpdateCache(cache: UpdateCache): void {
  mkdirSync(birdyBeepConfigDir(), { recursive: true, mode: 0o700 });
  writeFileSync(updateCachePath(), `${JSON.stringify(cache)}\n`, { mode: 0o600 });
}

/** Fetch the `latest` dist-tag version from the registry, or throw a concise reason. */
async function fetchLatestVersion(
  registryUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const url = `${registryUrl.replace(/\/+$/, "")}/${PACKAGE_PATH}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string" || body.version.length === 0) {
      throw new Error("registry response had no version");
    }
    return body.version;
  } finally {
    clearTimeout(timer);
  }
}

/** The two-line upgrade notice printed to stderr (lowercase/chirpy per the Perch voice). */
function renderNotice(current: string, latest: string): string {
  return (
    `a new version of birdybeep is available: ${current} → ${latest}\n` +
    `upgrade with: npm install -g ${PACKAGE_NAME}@latest`
  );
}

export interface NotifyUpdateOptions {
  /** Resolved top-level command name (used to skip `hook` / `report-status`). */
  command?: string;
  flags: GlobalFlags;
  io: Io;
  // --- injectables (production defaults are the real registry / fs / clock / env / TTY) ---
  fetchImpl?: typeof fetch;
  currentVersion?: string;
  registryUrl?: string;
  now?: number;
  intervalMs?: number;
  timeoutMs?: number;
  /** Override the stderr-TTY gate (tests set this true to exercise the notice deterministically). */
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  readCache?: () => UpdateCache | null;
  writeCache?: (cache: UpdateCache) => void;
}

/**
 * The notifier entry point, invoked by the framework after an eligible command runs. Reads the
 * cache, refreshes from the registry when stale (TTL-gated, short timeout, best-effort), and prints
 * the upgrade notice to stderr when a newer version exists. Never throws.
 */
export async function maybeNotifyUpdate(opts: NotifyUpdateOptions): Promise<void> {
  try {
    // Hot-path / internal commands: bail before any work so the harness is never slowed.
    if (opts.command !== undefined && SKIP_COMMANDS.has(opts.command)) return;
    // Machine/script output or explicit non-interactive: no chatter on stderr.
    if (opts.flags.json || opts.flags.nonInteractive) return;

    const env = opts.env ?? process.env;
    if (env["BIRDYBEEP_NO_UPDATE_NOTIFIER"] || env["NO_UPDATE_NOTIFIER"] || env["CI"]) return;

    const isTTY = opts.isTTY ?? Boolean(process.stderr.isTTY);
    if (!isTTY) return; // don't nag in pipes/logs

    const current = opts.currentVersion ?? CLI_VERSION;
    const now = opts.now ?? Date.now();
    const intervalMs = opts.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    const readCache = opts.readCache ?? readUpdateCache;
    const writeCache = opts.writeCache ?? writeUpdateCache;

    let cache = readCache();
    if (cache === null || now - cache.checkedAt >= intervalMs) {
      // Refresh at most once per interval. On failure, keep the last-known `latest` (so a
      // previously-seen update still shows) but still stamp `checkedAt` to back off, never hammer.
      let latest = cache?.latest ?? null;
      try {
        latest = await fetchLatestVersion(
          opts.registryUrl ?? resolveRegistryUrl(),
          opts.fetchImpl ?? fetch,
          opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      } catch {
        /* offline / registry error: fall back to last-known latest, back off for the interval */
      }
      cache = { checkedAt: now, latest };
      try {
        writeCache(cache);
      } catch {
        /* config dir not writable: notice still works this run, just won't be cached */
      }
    }

    if (cache.latest !== null && isNewer(current, cache.latest)) {
      opts.io.errline(renderNotice(current, cache.latest));
    }
  } catch {
    /* the notifier is best-effort — it must never break or slow a command */
  }
}
