/**
 * Per-install hashing salt (§15.3, birdybeep-agent-ofi).
 *
 * WHY THIS EXISTS. Path hashes and the machine fingerprint used to be a bare,
 * unsalted `sha256(value)`. Those inputs are LOW ENTROPY — `/Users/<name>/dev/<repo>`,
 * a hostname, a MAC — so the mapping value→hash is identical on every machine on
 * earth and an attacker holding the stored hashes (a DB leak, a log dump) reverses
 * them by dictionary/precompute. Truncating to 64 bits made it cheaper still.
 *
 * The fix is a per-install random 32-byte salt used as an HMAC key. Brute force now
 * requires the salt, which never leaves the machine — so the hashes are opaque to
 * anyone with only the server-side data, while staying STABLE for this install (the
 * product correlates on them; see below). Note a *static* pepper compiled into the
 * source would be worthless here: this package is public and MIT, so an attacker just
 * reads it out of the npm tarball. Only a per-install secret actually raises the bar.
 *
 * STABILITY CONTRACT. The salt is persisted in the user DATA dir with strict perms and
 * reused forever after. Same machine → same salt → same hashes across runs, so:
 *   - path hashes still correlate within a machine (that is all they are used for), and
 *   - the machine fingerprint still dedups `machine_installations` at pair time.
 * If the data dir is WIPED, a new salt is generated and the fingerprint changes — the
 * next `birdybeep pair` mints a new installation instead of re-pairing the old row. That
 * is the unavoidable price of non-reversibility: a hash that an attacker cannot
 * reconstruct from host signals is, by definition, one WE cannot reconstruct either.
 * {@link getPersistedInstallSalt} therefore fails LOUDLY rather than let pairing
 * silently duplicate installs off an ephemeral salt.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { birdyBeepDataDir } from "./paths";

/** Env override for the install salt (hex). Lets CI / the E2E rig pin a deterministic salt. */
export const INSTALL_SALT_ENV = "BIRDYBEEP_INSTALL_SALT";

/** Filename of the persisted salt inside the user data dir. */
export const INSTALL_SALT_FILENAME = "install-salt";

/** 32 bytes: far past any brute-force of the low-entropy inputs we key with it. */
const SALT_BYTES = 32;

/** A salt is stored (and accepted) as lowercase hex of at least 16 bytes. */
const SALT_RE = /^[0-9a-f]{32,}$/;

/** Absolute path to the persisted salt file. */
export function installSaltPath(): string {
  return join(birdyBeepDataDir(), INSTALL_SALT_FILENAME);
}

/** Process-level cache: the hook path hashes several strings per fire; read the file once. */
let cached: { salt: string; persisted: boolean } | undefined;

/** Drop the cached salt. Tests only — each temp HOME must resolve its own salt. */
export function resetInstallSaltCache(): void {
  cached = undefined;
}

function readSalt(file: string): string | undefined {
  try {
    const raw = readFileSync(file, "utf8").trim();
    return SALT_RE.test(raw) ? raw : undefined;
  } catch {
    return undefined; // absent or unreadable
  }
}

/**
 * Load the persisted salt, creating it on first use.
 *
 * Concurrency matters: several hook processes can fire at once on a cold install, and if
 * each minted its own salt the path hashes would stop correlating. The write is therefore
 * an EXCLUSIVE create (`wx`) — exactly one process wins, and every loser adopts the
 * winner's salt by re-reading the file.
 */
function loadOrCreate(): { salt: string; persisted: boolean } {
  const override = process.env[INSTALL_SALT_ENV]?.trim().toLowerCase();
  if (override && SALT_RE.test(override)) return { salt: override, persisted: true };

  const file = installSaltPath();
  const existing = readSalt(file);
  if (existing) return { salt: existing, persisted: true };

  const salt = randomBytes(SALT_BYTES).toString("hex");
  try {
    // 0o700/0o600: the salt is a secret — it is what makes the hashes irreversible.
    // (Modes are advisory no-ops on Windows; ACLs on %LOCALAPPDATA% carry it there.)
    mkdirSync(birdyBeepDataDir(), { recursive: true, mode: 0o700 });
    writeFileSync(file, salt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { salt, persisted: true };
  } catch {
    // Lost the create race → the winner's salt is on disk; adopt it so we agree.
    const winner = readSalt(file);
    if (winner) return { salt: winner, persisted: true };
    // Data dir genuinely unwritable (read-only FS, locked-down CI). Stay PRIVATE and keep
    // the harness moving: hash with an ephemeral salt. Hashes are still irreversible, they
    // just do not correlate across runs. Callers that REQUIRE stability must use
    // getPersistedInstallSalt() and surface the failure instead of silently degrading.
    return { salt, persisted: false };
  }
}

/**
 * The install's hashing salt. Never throws: the hook path must not break the harness.
 * Falls back to an ephemeral (per-process) salt if the data dir cannot be written —
 * privacy is preserved, only cross-run correlation is lost.
 */
export function getInstallSalt(): string {
  cached ??= loadOrCreate();
  return cached.salt;
}

/**
 * The install's salt, guaranteed to be PERSISTED — for callers whose correctness depends
 * on the hash being stable across runs (the machine fingerprint, which dedups
 * `machine_installations` at pair time). Throws rather than hand back an ephemeral salt:
 * pairing off an ephemeral salt would mint a duplicate installation on every run and burn
 * the user's install cap, which is far worse than a loud, fixable error.
 */
export function getPersistedInstallSalt(): string {
  cached ??= loadOrCreate();
  if (!cached.persisted) {
    throw new Error(
      `BirdyBeep could not persist its install salt to ${installSaltPath()}. ` +
        `The machine fingerprint would not be stable, so pairing would create a duplicate ` +
        `machine on every run. Make the data directory writable and retry ` +
        `(or set ${INSTALL_SALT_ENV} to a 32+ char hex string).`,
    );
  }
  return cached.salt;
}
