/**
 * Machine installation token storage (§7.2, §15.1): the OS keychain where usable,
 * a strict-permission file fallback (file 0600, dir 0700, under the user DATA dir)
 * otherwise — and NEVER a repo-local file or harness config. The sender reads the
 * token at send time; `logout`/revoke clears it; rotation overwrites it.
 *
 * The keychain is behind an injectable {@link KeychainBackend} so the store logic
 * is unit-tested with a fake backend (the real OS keychain is never touched by the
 * suite). On a headless/SSH machine with no secret service, the file fallback is
 * the working path — which is exactly what CI Linux/Windows exercise.
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { birdyBeepDataDir } from "./paths";

const execFileAsync = promisify(execFile);

/** Keychain namespacing for the single machine installation token. */
const SERVICE = "birdybeep";
const ACCOUNT = "machine-token";

export type TokenStoreKind = "keychain" | "file";

export interface TokenStore {
  readonly kind: TokenStoreKind;
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** Pluggable OS-keychain backend. Real impls shell out; tests inject a fake. */
export interface KeychainBackend {
  /** Whether this backend can be used on the current machine. */
  readonly available: boolean;
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

// ── File fallback (the always-available, fully-tested path) ──────────────────

export interface FileTokenStoreOptions {
  /** Override the token file path (tests). Default `<dataDir>/token`. */
  path?: string;
}

export class FileTokenStore implements TokenStore {
  readonly kind = "file";
  readonly path: string;

  constructor(options: FileTokenStoreOptions = {}) {
    this.path = options.path ?? join(birdyBeepDataDir(), "token");
  }

  // Sync internals, Promise-returning to satisfy the TokenStore interface.
  get(): Promise<string | null> {
    if (!existsSync(this.path)) return Promise.resolve(null);
    this.#repairPerms();
    const raw = readFileSync(this.path, "utf8").trim();
    return Promise.resolve(raw.length > 0 ? raw : null);
  }

  set(token: string): Promise<void> {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, token, { mode: 0o600 });
    renameSync(tmp, this.path);
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    rmSync(this.path, { force: true });
    return Promise.resolve();
  }

  /** Repair a too-permissive token file (§15.1: strict perms). POSIX only. */
  #repairPerms(): void {
    if (process.platform === "win32") return;
    try {
      if ((statSync(this.path).mode & 0o077) !== 0) chmodSync(this.path, 0o600);
    } catch {
      /* ignore */
    }
  }
}

// ── Keychain store (wraps a backend) ─────────────────────────────────────────

export class KeychainTokenStore implements TokenStore {
  readonly kind = "keychain";
  readonly #backend: KeychainBackend;

  constructor(backend: KeychainBackend) {
    this.#backend = backend;
  }

  get(): Promise<string | null> {
    return this.#backend.get(SERVICE, ACCOUNT);
  }

  set(token: string): Promise<void> {
    return this.#backend.set(SERVICE, ACCOUNT, token);
  }

  clear(): Promise<void> {
    return this.#backend.delete(SERVICE, ACCOUNT);
  }
}

// ── Real macOS keychain backend (`security`). Not exercised by the unit suite. ──

/** A backend that reports itself unavailable (Linux without secret service / Windows fallback). */
export const unavailableKeychainBackend: KeychainBackend = {
  available: false,
  get: () => Promise.resolve(null),
  set: () => Promise.reject(new Error("keychain unavailable")),
  delete: () => Promise.resolve(),
};

/** macOS Keychain via the built-in `security` CLI. */
export function macosKeychainBackend(): KeychainBackend {
  return {
    available: process.platform === "darwin",
    async get(service, account) {
      try {
        const { stdout } = await execFileAsync("security", [
          "find-generic-password",
          "-s",
          service,
          "-a",
          account,
          "-w",
        ]);
        const value = stdout.replace(/\n$/, "");
        return value.length > 0 ? value : null;
      } catch {
        return null; // not found / locked → treat as absent
      }
    },
    async set(service, account, secret) {
      // -U updates an existing item; namespaced to BirdyBeep's service/account.
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        account,
        "-w",
        secret,
      ]);
    },
    async delete(service, account) {
      try {
        await execFileAsync("security", ["delete-generic-password", "-s", service, "-a", account]);
      } catch {
        /* already absent → fine */
      }
    },
  };
}

/** The default keychain backend for the current OS (best-effort; file fallback otherwise). */
export function defaultKeychainBackend(): KeychainBackend {
  if (process.platform === "darwin") return macosKeychainBackend();
  // Linux Secret Service / Windows Credential Manager backends can be added later;
  // until then those platforms use the strict-perm file fallback (§7.2 headless path).
  return unavailableKeychainBackend;
}

export interface TokenStoreOptions {
  /** Inject a keychain backend (tests / custom). Defaults to the OS backend. */
  backend?: KeychainBackend;
  /** Override the fallback file path (tests). */
  filePath?: string;
}

/** Resolve the PRIMARY store: keychain when available, else the strict-perm file. */
export function resolveTokenStore(options: TokenStoreOptions = {}): TokenStore {
  const backend = options.backend ?? defaultKeychainBackend();
  if (backend.available) return new KeychainTokenStore(backend);
  return new FileTokenStore(options.filePath !== undefined ? { path: options.filePath } : {});
}

// ── High-level API used by the CLI + sender ──────────────────────────────────

/** Store the machine token in the primary store (keychain if available, else file). */
export async function setToken(
  token: string,
  options: TokenStoreOptions = {},
): Promise<TokenStoreKind> {
  const store = resolveTokenStore(options);
  await store.set(token);
  return store.kind;
}

/** Read the machine token: keychain first if available, then the file fallback. */
export async function getToken(options: TokenStoreOptions = {}): Promise<string | null> {
  const backend = options.backend ?? defaultKeychainBackend();
  if (backend.available) {
    const fromKeychain = await new KeychainTokenStore(backend).get();
    if (fromKeychain !== null) return fromKeychain;
  }
  const file = new FileTokenStore(options.filePath !== undefined ? { path: options.filePath } : {});
  return file.get();
}

/** Remove the token from BOTH keychain and file fallback (logout / revoke). */
export async function clearToken(options: TokenStoreOptions = {}): Promise<void> {
  const backend = options.backend ?? defaultKeychainBackend();
  if (backend.available) await new KeychainTokenStore(backend).clear();
  await new FileTokenStore(
    options.filePath !== undefined ? { path: options.filePath } : {},
  ).clear();
}
