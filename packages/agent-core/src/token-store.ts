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
import { spawn } from "node:child_process";
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

import { birdyBeepDataDir } from "./paths";

/** Keychain namespacing for the single machine installation token. */
const SERVICE = "birdybeep";
const ACCOUNT = "machine-token";

export type TokenStoreKind = "keychain" | "file";

/**
 * What a token read actually found — an ERROR is not an ABSENCE (birdybeep-agent-gcgp.23).
 *
 * `null` collapsed the two, and after gcgp.4 that became data loss: "no token" DROPS the event
 * deliberately, so a paired user whose keychain was merely locked (screen lock, or a login
 * before the first unlock) lost events and was told they were not paired. Callers branch on
 * `state`: `absent` is the gcgp.4 drop, `unavailable` is transient — queue it and try again.
 */
export type TokenLookup =
  | { readonly state: "present"; readonly token: string }
  | { readonly state: "absent" }
  /** The store could not answer. `reason` is a short, secret-free description for the user. */
  | { readonly state: "unavailable"; readonly reason: string };

export interface TokenStore {
  readonly kind: TokenStoreKind;
  /** The full answer, including "the store failed" (gcgp.23). */
  read(): Promise<TokenLookup>;
  /** The token, or `null` for BOTH absence and failure. Prefer {@link TokenStore.read}. */
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** Pluggable OS-keychain backend. Real impls shell out; tests inject a fake. */
export interface KeychainBackend {
  /** Whether this backend can be used on the current machine. */
  readonly available: boolean;
  /**
   * Resolve `null` ONLY for a genuine absence (no such item). Any other failure — a locked
   * keychain, a denied prompt, a backend that is not answering — must REJECT, because the
   * caller drops events on absence and queues them on failure (gcgp.23).
   */
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

/** Longest failure description we pass on — a diagnostic line, not a log dump. */
const MAX_REASON_LENGTH = 160;

/**
 * A one-line, secret-free description of a token-store failure, for `status`/`doctor`/the hook's
 * stderr line. Never carries token material: the keychain only echoes a secret on a SUCCESSFUL
 * read, and the file store's errors are `fs` codes. Collapsed to one line and length-capped.
 */
export function describeTokenStoreFailure(store: TokenStoreKind, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const flat = raw.replace(/\s+/g, " ").trim();
  const message =
    flat.length > MAX_REASON_LENGTH ? `${flat.slice(0, MAX_REASON_LENGTH - 1)}…` : flat;
  const where = store === "keychain" ? "OS keychain" : "token file";
  return message.length > 0 ? `${where}: ${message}` : `${where}: unreadable`;
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
  read(): Promise<TokenLookup> {
    try {
      if (!existsSync(this.path)) return Promise.resolve({ state: "absent" });
      this.#repairPerms();
      const raw = readFileSync(this.path, "utf8").trim();
      return Promise.resolve(
        raw.length > 0 ? { state: "present", token: raw } : { state: "absent" },
      );
    } catch (error) {
      // The file EXISTS but will not read (EACCES on a hostile umask fix, EISDIR, a failing
      // disk). Before gcgp.23 this threw out of the sender and into the harness's hook.
      return Promise.resolve({
        state: "unavailable",
        reason: describeTokenStoreFailure("file", error),
      });
    }
  }

  async get(): Promise<string | null> {
    const lookup = await this.read();
    return lookup.state === "present" ? lookup.token : null;
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

  async read(): Promise<TokenLookup> {
    try {
      const token = await this.#backend.get(SERVICE, ACCOUNT);
      return token !== null && token.length > 0 ? { state: "present", token } : { state: "absent" };
    } catch (error) {
      // A locked keychain is the everyday case, not an exotic one — and it says NOTHING about
      // whether this machine is paired (gcgp.23).
      return { state: "unavailable", reason: describeTokenStoreFailure("keychain", error) };
    }
  }

  async get(): Promise<string | null> {
    const lookup = await this.read();
    return lookup.state === "present" ? lookup.token : null;
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

/**
 * How the macOS `security` CLI is invoked. Injectable so the unit suite can capture the
 * exact argv/stdin we hand to the child WITHOUT touching the real OS keychain — that is
 * what pins the "no secret on argv" invariant below.
 *
 * Resolves the child's stdout; rejects on a non-zero exit.
 */
export type SecurityRunner = (args: readonly string[], stdin?: string) => Promise<string>;

/**
 * Spawn options for every `security` invocation. Exported so the pty regression test can pin
 * the no-controlling-terminal invariant against the same object the real code uses, rather
 * than a copy that could drift away from it.
 */
export const SECURITY_SPAWN_OPTIONS: {
  stdio: ["pipe", "pipe", "pipe"];
  detached: boolean;
} = {
  stdio: ["pipe", "pipe", "pipe"],
  detached: true,
};

/**
 * A non-zero `security` exit, with the status preserved so the caller can tell "no such item"
 * from "the keychain would not answer" (gcgp.23) instead of pattern-matching a message.
 */
export class SecurityCommandError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(subcommand: string, exitCode: number | null, stderr: string) {
    super(`security ${subcommand} exited ${String(exitCode)}: ${stderr.trim()}`);
    this.name = "SecurityCommandError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * `security`'s exit status for errSecItemNotFound — the ONLY failure that means "this machine
 * has no BirdyBeep token". Everything else (51 errSecInteractionNotAllowed on a locked keychain
 * or a headless session, 36 errSecAuthFailed on a denied prompt, a backend that is not running)
 * is a store that could not answer, and absence must never be inferred from it.
 */
export const SECURITY_ITEM_NOT_FOUND = 44;
/** Same verdict, read off the message, for a `security` build that exits with a different code. */
const ITEM_NOT_FOUND_TEXT = /could not be found in the keychain/i;
/**
 * `spawn` errno codes meaning the `security` BINARY could not be launched at all. That is not a
 * locked keychain — it is a machine with no keychain service to read, exactly like the Linux and
 * Windows fallback path, and it is PERMANENT. Queueing forever against a condition that never
 * clears is the very failure gcgp.4 fixed, so this falls through to the file store instead.
 */
const SPAWN_FAILURE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR"]);

/** Spawn the real `security` binary, piping `stdin` in (never the shell, never argv). */
const spawnSecurity: SecurityRunner = (args, stdin) =>
  new Promise<string>((resolve, reject) => {
    // `detached: true` puts the child in a NEW SESSION with no controlling terminal, and that
    // is load-bearing rather than cosmetic (birdybeep-agent-lz9).
    //
    // `security` reads a passphrase with readpassphrase(3), which opens /dev/tty whenever a
    // controlling terminal exists and IGNORES the stdin pipe entirely. Under a real interactive
    // terminal — the ONLY way a human ever pairs — the secret we write below therefore went
    // nowhere: the user got `security`'s own "password data for new item:" prompt, and whatever
    // they typed became the item. Detaching removes the tty, so readpassphrase falls back to
    // stdin and the piped secret actually lands.
    //
    // This is invisible to every automated run: CI, vitest and cloud sessions are all TTY-less,
    // which is the one condition under which the un-detached form works. The regression test
    // therefore allocates a pty on purpose — see token-store.pty.test.ts.
    const child = spawn("security", [...args], SECURITY_SPAWN_OPTIONS);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new SecurityCommandError(args[0] ?? "?", code, stderr));
    });
    // If `security` exits before draining stdin we get EPIPE; the `close` handler above
    // reports the real failure, so swallow it rather than crashing the host process.
    child.stdin.once("error", () => {
      /* EPIPE — see above */
    });
    child.stdin.end(stdin ?? "");
  });

/**
 * Read a secret back out of the keychain: `null` when there is no item to read (it is genuinely
 * absent, or `security` itself cannot be launched — see {@link SPAWN_FAILURE_CODES}), and THROWS
 * when the keychain would not answer (gcgp.23 — a locked keychain must not read as "not paired").
 * An unrecognizable failure is treated as a failure, not as an absence: that direction costs a
 * queued event, the other costs a lost one.
 */
async function findSecret(
  run: SecurityRunner,
  service: string,
  account: string,
): Promise<string | null> {
  try {
    const stdout = await run(["find-generic-password", "-s", service, "-a", account, "-w"]);
    const value = stdout.replace(/\n$/, "");
    return value.length > 0 ? value : null;
  } catch (error) {
    if (isItemNotFound(error) || isBinaryUnlaunchable(error)) return null;
    throw error;
  }
}

/** Does this `security` failure mean the item is absent (rather than unreadable)? */
function isItemNotFound(error: unknown): boolean {
  if (error instanceof SecurityCommandError) {
    return error.exitCode === SECURITY_ITEM_NOT_FOUND || ITEM_NOT_FOUND_TEXT.test(error.stderr);
  }
  return error instanceof Error && ITEM_NOT_FOUND_TEXT.test(error.message);
}

/** Did `spawn` fail to launch `security` at all? (No keychain here — not a locked one.) */
function isBinaryUnlaunchable(error: unknown): boolean {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SPAWN_FAILURE_CODES.has(code);
}

export interface MacosKeychainOptions {
  /** Override how `security` is invoked (tests). Defaults to spawning the real binary. */
  run?: SecurityRunner;
}

/** macOS Keychain via the built-in `security` CLI. */
export function macosKeychainBackend(options: MacosKeychainOptions = {}): KeychainBackend {
  const run = options.run ?? spawnSecurity;
  return {
    available: process.platform === "darwin",
    get: (service, account) => findSecret(run, service, account),
    async set(service, account, secret) {
      // SECURITY (birdybeep-agent-5qd): the token must NEVER be an argv element. A process's
      // argument vector is world-readable on macOS (`ps -axo args` shows other users' args),
      // so the old `-w <token>` form let any co-located local process scrape the durable
      // machine token during the write. Instead we pass `-w` as the LAST option, which makes
      // `security` PROMPT for the password, and we feed that prompt over a pipe — so the secret
      // never appears in the process table.
      //
      // That pipe only reaches `security` because spawnSecurity detaches the child from the
      // controlling terminal; with a tty present it would read /dev/tty instead and silently
      // ignore everything below (birdybeep-agent-lz9).
      //
      // Two wrinkles, both established by running the real binary (see the guarded E2E below):
      //  1. It prompts TWICE ("password data for new item" + "retype"), so the secret is fed
      //     twice, each newline-terminated. A newline inside the secret would desync that, so
      //     reject it up front rather than corrupt the item.
      //  2. If the two feeds disagree, `security` stores an EMPTY password and STILL EXITS 0.
      //     A zero exit is therefore not proof of a write, so we read the value back and
      //     verify — otherwise a silent mis-store would wipe the user's token and leave them
      //     failing auth forever with no diagnostic.
      if (/[\r\n]/.test(secret)) {
        throw new Error("machine token must not contain a newline; refusing to store it");
      }
      // -U updates an existing item; namespaced to BirdyBeep's service/account.
      await run(
        ["add-generic-password", "-U", "-s", service, "-a", account, "-w"],
        `${secret}\n${secret}\n`,
      );
      if ((await findSecret(run, service, account)) !== secret) {
        // Never include the secret itself in the message — it would land in logs.
        throw new Error("macOS keychain did not store the machine token (read-back mismatch)");
      }
    },
    async delete(service, account) {
      try {
        await run(["delete-generic-password", "-s", service, "-a", account]);
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

/**
 * Read the machine token: keychain first if available, then the file fallback — and say WHICH
 * of "no token" and "the store would not answer" happened (birdybeep-agent-gcgp.23).
 *
 * A token found anywhere wins. Otherwise a store that FAILED outranks a store that was merely
 * empty: a locked keychain plus an empty file fallback is not evidence that this machine is
 * unpaired, and reporting it as such is what turned a screen lock into dropped events.
 */
export async function readToken(options: TokenStoreOptions = {}): Promise<TokenLookup> {
  const backend = options.backend ?? defaultKeychainBackend();
  let keychain: TokenLookup = { state: "absent" };
  if (backend.available) {
    keychain = await new KeychainTokenStore(backend).read();
    if (keychain.state === "present") return keychain;
  }
  const file = await new FileTokenStore(
    options.filePath !== undefined ? { path: options.filePath } : {},
  ).read();
  if (file.state === "present") return file;
  if (keychain.state === "unavailable") return keychain;
  return file; // absent, or the file store's own failure
}

/**
 * The machine token, or `null` for BOTH "not paired" and "the store failed". Kept for callers
 * where the difference cannot change the answer (`pair`'s already-paired short-circuit,
 * `logout`, the adapters' status probes). Anything that DECIDES the fate of an event —
 * the sender, `status`, `doctor` — must use {@link readToken} instead (gcgp.23).
 */
export async function getToken(options: TokenStoreOptions = {}): Promise<string | null> {
  const lookup = await readToken(options);
  return lookup.state === "present" ? lookup.token : null;
}

/** Remove the token from BOTH keychain and file fallback (logout / revoke). */
export async function clearToken(options: TokenStoreOptions = {}): Promise<void> {
  const backend = options.backend ?? defaultKeychainBackend();
  if (backend.available) await new KeychainTokenStore(backend).clear();
  await new FileTokenStore(
    options.filePath !== undefined ? { path: options.filePath } : {},
  ).clear();
}
