/**
 * CORE-TOKEN-STORE proof: keychain path round-trips (via a fake backend so the real
 * OS keychain is never touched), the strict-perm FILE fallback round-trips at 0600,
 * a world-readable file is repaired, clear removes from BOTH, rotation overwrites,
 * and — the headline invariant — the token NEVER lands in a repo-local file.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import {
  assertNoTokenInRepo,
  createSandbox,
  findRepoRoot,
  type Sandbox,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { birdyBeepDataDir } from "./paths";
import {
  clearToken,
  FileTokenStore,
  getToken,
  type KeychainBackend,
  KeychainTokenStore,
  macosKeychainBackend,
  readToken,
  resolveTokenStore,
  SECURITY_ITEM_NOT_FOUND,
  SecurityCommandError,
  type SecurityRunner,
  setToken,
  unavailableKeychainBackend,
} from "./token-store";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

/** In-memory fake keychain — lets us exercise the keychain path without the real OS keychain. */
function fakeKeychain(): KeychainBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const key = (s: string, a: string) => `${s}:${a}`;
  return {
    available: true,
    store,
    get: (s, a) => Promise.resolve(store.get(key(s, a)) ?? null),
    set: (s, a, secret) => {
      store.set(key(s, a), secret);
      return Promise.resolve();
    },
    delete: (s, a) => {
      store.delete(key(s, a));
      return Promise.resolve();
    },
  };
}

const POSIX = process.platform !== "win32";
// Runtime-generated, NOT a source literal — a hardcoded token would itself sit in
// this repo file and (correctly) trip assertNoTokenInRepo.
const TOKEN = `bbm_TESTONLY_${randomUUID()}`;

describe("keychain path (fake backend — real OS keychain never touched)", () => {
  it("round-trips set/get/clear and does NOT create the fallback file", async () => {
    sandbox = createSandbox();
    const backend = fakeKeychain();
    const filePath = sandbox.path("data", "token");

    expect(await setToken(TOKEN, { backend, filePath })).toBe("keychain");
    expect(await getToken({ backend, filePath })).toBe(TOKEN);
    expect(existsSync(filePath)).toBe(false); // keychain machine → no fallback file
    expect(backend.store.size).toBe(1);

    await clearToken({ backend, filePath });
    expect(await getToken({ backend, filePath })).toBeNull();
  });
});

describe("file fallback (no usable keychain)", () => {
  it("creates a 0600 token file under the data dir and round-trips", async () => {
    sandbox = createSandbox();
    const kind = await setToken(TOKEN, { backend: unavailableKeychainBackend });
    expect(kind).toBe("file");
    const store = resolveTokenStore({ backend: unavailableKeychainBackend });
    expect(store.kind).toBe("file");
    const filePath = (store as FileTokenStore).path;
    expect(filePath.startsWith(birdyBeepDataDir())).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    expect(await getToken({ backend: unavailableKeychainBackend })).toBe(TOKEN);
    if (POSIX) expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("repairs a world-readable fallback file on read", async () => {
    if (!POSIX) return;
    sandbox = createSandbox();
    const filePath = sandbox.path("data", "token");
    const store = new FileTokenStore({ path: filePath });
    await store.set(TOKEN);
    writeFileSync(filePath, TOKEN, { mode: 0o644 }); // loosen
    expect(await store.get()).toBe(TOKEN);
    expect(statSync(filePath).mode & 0o777).toBe(0o600); // repaired
  });

  it("rotation overwrites cleanly", async () => {
    sandbox = createSandbox();
    const filePath = sandbox.path("data", "token");
    const store = new FileTokenStore({ path: filePath });
    await store.set("old-token");
    await store.set("new-token");
    expect(await store.get()).toBe("new-token");
    expect(readFileSync(filePath, "utf8")).toBe("new-token");
  });
});

describe("clearToken removes from BOTH stores", () => {
  it("clears keychain and file", async () => {
    sandbox = createSandbox();
    const backend = fakeKeychain();
    const filePath = sandbox.path("data", "token");
    // Seed both (simulate a machine that has the token in both places).
    await backend.set("birdybeep", "machine-token", TOKEN);
    await new FileTokenStore({ path: filePath }).set(TOKEN);
    await clearToken({ backend, filePath });
    expect(backend.store.size).toBe(0);
    expect(existsSync(filePath)).toBe(false);
  });
});

/**
 * birdybeep-agent-5qd regression pin. The macOS backend must NEVER hand the durable
 * machine token to `security` as a command-line argument: a process's argv is
 * world-readable on macOS (`ps -axo args`), so an argv secret is scrapeable by any
 * co-located local process during the write. The backend must feed it over stdin.
 *
 * The runner is injected so we capture the EXACT argv/stdin handed to the child and
 * never touch the real OS keychain. The fake emulates the real `security` prompt
 * semantics observed by running the binary: `add-generic-password … -w` (bare, last)
 * prompts TWICE and reads both feeds from stdin; if the two feeds disagree it stores
 * an EMPTY password yet still exits 0.
 */
function recordingSecurity(): {
  run: SecurityRunner;
  calls: { args: string[]; stdin: string | undefined }[];
  store: Map<string, string>;
} {
  const calls: { args: string[]; stdin: string | undefined }[] = [];
  const store = new Map<string, string>();
  const flag = (args: readonly string[], f: string) => args[args.indexOf(f) + 1];
  const key = (args: readonly string[]) => `${flag(args, "-s")}:${flag(args, "-a")}`;
  const run: SecurityRunner = (args, stdin) => {
    calls.push({ args: [...args], stdin });
    const cmd = args[0];
    if (cmd === "add-generic-password") {
      // Real `security` prompts twice; both lines come from stdin. Mismatch → empty item.
      const [first = "", second = ""] = (stdin ?? "").split("\n");
      store.set(key(args), first === second ? first : "");
      return Promise.resolve(""); // exits 0 regardless — the headline footgun
    }
    if (cmd === "find-generic-password") {
      const v = store.get(key(args));
      // Absent → the real binary's exit 44 + message, so the ABSENT-vs-UNREADABLE split this
      // fake feeds (gcgp.23) is the one the real `security` produces.
      if (v === undefined) {
        return Promise.reject(
          new SecurityCommandError(
            cmd,
            SECURITY_ITEM_NOT_FOUND,
            "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
          ),
        );
      }
      return Promise.resolve(`${v}\n`); // present (even if empty) → value + trailing newline
    }
    if (cmd === "delete-generic-password") {
      store.delete(key(args));
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected security subcommand: ${String(cmd)}`));
  };
  return { run, calls, store };
}

describe("macOS keychain backend: token is fed via stdin, NEVER on argv (5qd)", () => {
  const TOKEN_5QD = `bbm_TESTONLY_5qd_${randomUUID()}`;

  it("keeps the token out of every child argv and passes it on stdin", async () => {
    const { run, calls } = recordingSecurity();
    await macosKeychainBackend({ run }).set("birdybeep", "machine-token", TOKEN_5QD);

    // The headline invariant: the raw token appears in NO argv element of ANY call.
    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg).not.toBe(TOKEN_5QD);
        expect(arg).not.toContain(TOKEN_5QD);
      }
      expect(call.args.join(" ")).not.toContain(TOKEN_5QD);
    }

    // It is instead delivered over stdin to the store call, which uses the prompt form
    // (`-w` bare and LAST — never `-w <token>`).
    const addCall = calls.find((c) => c.args[0] === "add-generic-password");
    expect(addCall).toBeDefined();
    expect(addCall?.args.at(-1)).toBe("-w");
    expect(addCall?.args).not.toContain(TOKEN_5QD);
    expect(addCall?.stdin ?? "").toContain(TOKEN_5QD);
  });

  it("round-trips set → get through the real prompt/stdin semantics", async () => {
    const { run } = recordingSecurity();
    const backend = macosKeychainBackend({ run });
    await backend.set("birdybeep", "machine-token", TOKEN_5QD);
    expect(await backend.get("birdybeep", "machine-token")).toBe(TOKEN_5QD);
  });

  it("detects a silent mis-store (mismatched feeds → empty item, exit 0) via read-back", async () => {
    // A runner that ignores stdin and always stores the empty string models `security`
    // when the two prompt feeds disagree: it exits 0 but wrote nothing usable.
    const store = new Map<string, string>();
    const run: SecurityRunner = (args) => {
      const s = args[args.indexOf("-s") + 1];
      const a = args[args.indexOf("-a") + 1];
      if (args[0] === "add-generic-password") {
        store.set(`${s}:${a}`, "");
        return Promise.resolve("");
      }
      const v = store.get(`${s}:${a}`);
      if (v === undefined) return Promise.reject(new Error("not found"));
      return Promise.resolve(`${v}\n`);
    };
    await expect(
      macosKeychainBackend({ run }).set("birdybeep", "machine-token", TOKEN_5QD),
    ).rejects.toThrow(/did not store/i);
  });

  it("refuses a newline-bearing token (would desync the double prompt) without spawning", async () => {
    const { run, calls } = recordingSecurity();
    await expect(
      macosKeychainBackend({ run }).set("birdybeep", "machine-token", "line1\nline2"),
    ).rejects.toThrow(/newline/i);
    expect(calls).toHaveLength(0); // rejected before any child process was spawned
  });
});

describe("no-leak: the token never lands in a repo-local file", () => {
  it("stores in the sandbox (file fallback) but nowhere in the repo tree", async () => {
    sandbox = createSandbox();
    const filePath = sandbox.path("data", "token");
    await setToken(TOKEN, { backend: unavailableKeychainBackend, filePath });
    // The token IS in the sandbox file…
    expect(readFileSync(filePath, "utf8")).toBe(TOKEN);
    expect(filePath.startsWith(sandbox.home)).toBe(true);
    expect(filePath).not.toContain("birdybeep-agent/packages");
    // …and is in NO repo-local file.
    assertNoTokenInRepo(findRepoRoot(process.cwd()), TOKEN);
  });
});

/**
 * birdybeep-agent-gcgp.23 regression. `getToken` answered `null` for BOTH "this machine has no
 * token" and "the store would not answer", and after gcgp.4 those have opposite consequences:
 * absence DROPS the event on purpose, a failure must QUEUE it. macOS keychains lock all the
 * time (screen lock; a login before the first unlock), so the conflation turned an everyday,
 * self-healing condition into lost events plus a "not paired" message to a paired user.
 */
describe("gcgp.23: a store that FAILED is not a store that is EMPTY", () => {
  /** A keychain that is present and usable but currently refuses to answer (locked). */
  function lockedKeychain(message = "User interaction is not allowed."): KeychainBackend {
    return {
      available: true,
      get: () => Promise.reject(new Error(message)),
      set: () => Promise.reject(new Error(message)),
      delete: () => Promise.resolve(),
    };
  }

  it("reports `unavailable` (not `absent`) when the keychain rejects", async () => {
    sandbox = createSandbox();
    const lookup = await readToken({
      backend: lockedKeychain(),
      filePath: sandbox.path("data", "token"), // no file fallback on this machine either
    });
    expect(lookup.state).toBe("unavailable");
    if (lookup.state !== "unavailable") throw new Error("unreachable");
    expect(lookup.reason).toContain("User interaction is not allowed");
  });

  it("still finds a token in the file fallback when the keychain is locked", async () => {
    sandbox = createSandbox();
    const filePath = sandbox.path("data", "token");
    await new FileTokenStore({ path: filePath }).set(TOKEN);
    // A real token beats a broken store: an unreadable keychain must not mask one we DO have.
    expect(await readToken({ backend: lockedKeychain(), filePath })).toEqual({
      state: "present",
      token: TOKEN,
    });
  });

  it("keeps `getToken` null for both, so callers that cannot act on the difference are unchanged", async () => {
    sandbox = createSandbox();
    const filePath = sandbox.path("data", "token");
    expect(await getToken({ backend: lockedKeychain(), filePath })).toBeNull();
    expect(await getToken({ backend: unavailableKeychainBackend, filePath })).toBeNull();
  });

  it("reports a token file that exists but will not read as `unavailable`, and never throws", async () => {
    sandbox = createSandbox();
    // A path that exists and fails to read — the file-fallback machines' (Linux/Windows/headless)
    // version of a locked keychain. Before gcgp.23 this threw out of the sender into the harness.
    const filePath = sandbox.path("data", "token");
    mkdirSync(filePath, { recursive: true });
    const lookup = await new FileTokenStore({ path: filePath }).read();
    expect(lookup.state).toBe("unavailable");
    expect(await readToken({ backend: unavailableKeychainBackend, filePath })).toMatchObject({
      state: "unavailable",
    });
  });

  it("keeps reporting `absent` when the stores are genuinely empty (gcgp.4's drop path)", async () => {
    sandbox = createSandbox();
    expect(await readToken({ backend: unavailableKeychainBackend })).toEqual({ state: "absent" });
    const empty: KeychainBackend = {
      available: true,
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    expect(await readToken({ backend: empty, filePath: sandbox.path("data", "token") })).toEqual({
      state: "absent",
    });
  });

  it("never puts token material in the failure reason", async () => {
    sandbox = createSandbox();
    // A backend that leaks the secret into its own error message is the worst case; the reason
    // is a user-facing diagnostic, so pin the length cap that keeps any such spill bounded.
    const lookup = await readToken({
      backend: lockedKeychain(`denied while reading ${"x".repeat(400)}`),
      filePath: sandbox.path("data", "token"),
    });
    if (lookup.state !== "unavailable") throw new Error("expected unavailable");
    expect(lookup.reason.length).toBeLessThanOrEqual(200);
    expect(lookup.reason).toContain("…");
  });
});

/**
 * The macOS split, at the `security` boundary: exit 44 is the ONE status that means "no such
 * item". Everything else is a keychain that would not answer, and inferring absence from it is
 * what gcgp.23 fixes. Driven through the injected runner — the real OS keychain is never touched.
 */
describe("gcgp.23: classifying a `security` failure", () => {
  const rejectWith =
    (error: Error): SecurityRunner =>
    () =>
      Promise.reject(error);

  it("treats exit 44 (item not found) as ABSENT", async () => {
    const backend = macosKeychainBackend({
      run: rejectWith(
        new SecurityCommandError(
          "find-generic-password",
          SECURITY_ITEM_NOT_FOUND,
          "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
        ),
      ),
    });
    expect(await backend.get("birdybeep", "machine-token")).toBeNull();
    expect(await new KeychainTokenStore(backend).read()).toEqual({ state: "absent" });
  });

  it("treats a LOCKED keychain (exit 51) as unavailable, not as an empty one", async () => {
    const backend = macosKeychainBackend({
      run: rejectWith(
        new SecurityCommandError(
          "find-generic-password",
          51,
          "security: User interaction is not allowed.",
        ),
      ),
    });
    await expect(backend.get("birdybeep", "machine-token")).rejects.toThrow(/interaction/i);
    expect(await new KeychainTokenStore(backend).read()).toMatchObject({ state: "unavailable" });
  });

  it("treats an UNRECOGNIZABLE failure as unavailable — the direction that costs a queued event, not a lost one", async () => {
    const backend = macosKeychainBackend({ run: rejectWith(new Error("keychain went sideways")) });
    expect(await new KeychainTokenStore(backend).read()).toMatchObject({ state: "unavailable" });
  });

  /**
   * A `security` binary that cannot be LAUNCHED is not a locked keychain — it is a machine with
   * no keychain service, which is permanent. Queueing forever against a condition that never
   * clears is the gcgp.4 pathology, so this falls through to the file store and reads as absent.
   * (`birdybeep doctor` in a clean environment with no `security` on PATH must still say "no
   * machine token" — the smoke test pins it end-to-end.)
   */
  it.each(["ENOENT", "EACCES"])(
    "treats a spawn %s as ABSENT, not as a locked keychain",
    async (code) => {
      const spawnFailure = Object.assign(new Error(`spawn security ${code}`), { code });
      const backend = macosKeychainBackend({ run: rejectWith(spawnFailure) });
      expect(await backend.get("birdybeep", "machine-token")).toBeNull();
      expect(await new KeychainTokenStore(backend).read()).toEqual({ state: "absent" });
    },
  );
});
