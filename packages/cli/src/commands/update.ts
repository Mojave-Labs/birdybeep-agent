/**
 * `birdybeep update` (§9.4) — check whether a newer `@birdybeep/cli` is published and tell the
 * user exactly how to upgrade. This is a check-and-notify command, NOT a self-updater: the CLI
 * installs at the user/global level (`npm i -g` / `pnpm add -g` / `yarn global add`), so mutating
 * that install from inside the running process would be fragile (which package manager? which
 * permissions?) and a needless privileged surface for an auditable tool. Instead it queries the
 * npm registry's `latest` dist-tag (short timeout, best-effort, read-only), compares it against
 * the running version with a dependency-free semver comparison, and prints the upgrade command
 * when one is available. Never blocks long, never mutates anything. `--json` mirrors
 * `{ current, latest, updateAvailable, upgradeCommand? }`; exits non-zero only when the registry
 * check itself could not complete (so scripts can branch), never merely because you're behind.
 */
import { resolveRegistryUrl } from "../config";
import { type Command, EXIT } from "../framework";
import { CLI_VERSION } from "../version";

/** The published package this CLI upgrades to. */
export const PACKAGE_NAME = "@birdybeep/cli";
/** URL-encoded scoped path for the registry `latest` dist-tag endpoint. */
const PACKAGE_PATH = "@birdybeep%2Fcli";
/** Default best-effort timeout for the registry probe (matches `doctor`'s network probe). */
const DEFAULT_TIMEOUT_MS = 3000;

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

export interface UpdateCommandDeps {
  /** Registry fetch (tests inject a stub; default is the global `fetch`). */
  fetchImpl?: typeof fetch;
  /** The running version to compare against (default: the built-in `CLI_VERSION`). */
  currentVersion?: string;
  /** Override the registry base URL (default: `npm_config_registry` env → npm public registry). */
  registryUrl?: string;
  /** Abort the probe after this many ms (best-effort; default 3s). */
  timeoutMs?: number;
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

export function createUpdateCommand(deps: UpdateCommandDeps = {}): Command {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const upgradeCommand = `npm install -g ${PACKAGE_NAME}@latest`;

  return {
    name: "update",
    summary: "Check for a newer CLI version and show how to upgrade",
    usage: "birdybeep update [--json]",
    run: async (ctx) => {
      const current = deps.currentVersion ?? CLI_VERSION;
      const registryUrl = deps.registryUrl ?? resolveRegistryUrl();

      let latest: string;
      try {
        latest = await fetchLatestVersion(registryUrl, fetchImpl, timeoutMs);
      } catch (err) {
        // The check couldn't complete — best-effort, never alarming, but a defined non-zero so
        // scripts can tell "couldn't check" apart from "up to date".
        const reason = err instanceof Error ? err.message : String(err);
        if (ctx.flags.json) {
          ctx.io.result({ current, latest: null, updateAvailable: false, error: reason });
        } else {
          ctx.io.errline(`⚠ Couldn't check for updates: ${reason}.`);
          ctx.io.line(
            `You have birdybeep ${current}. See https://www.npmjs.com/package/${PACKAGE_NAME} to compare.`,
          );
        }
        return EXIT.ERROR;
      }

      const currentParsed = parseSemver(current);
      const latestParsed = parseSemver(latest);
      const updateAvailable =
        currentParsed !== null &&
        latestParsed !== null &&
        compareSemver(currentParsed, latestParsed) < 0;

      if (ctx.flags.json) {
        ctx.io.result({
          current,
          latest,
          updateAvailable,
          ...(updateAvailable ? { upgradeCommand } : {}),
        });
      } else if (updateAvailable) {
        ctx.io.line(`A new version of birdybeep is available: ${current} → ${latest}`);
        ctx.io.line(`Upgrade with:  ${upgradeCommand}`);
        ctx.io.line(
          `(pnpm: \`pnpm add -g ${PACKAGE_NAME}@latest\` · yarn: \`yarn global add ${PACKAGE_NAME}@latest\`)`,
        );
      } else {
        ctx.io.line(`✓ birdybeep ${current} is the latest version.`);
      }
      return EXIT.OK;
    },
  };
}
