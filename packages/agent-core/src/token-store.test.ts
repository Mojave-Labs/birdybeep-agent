/**
 * CORE-TOKEN-STORE proof: keychain path round-trips (via a fake backend so the real
 * OS keychain is never touched), the strict-perm FILE fallback round-trips at 0600,
 * a world-readable file is repaired, clear removes from BOTH, rotation overwrites,
 * and — the headline invariant — the token NEVER lands in a repo-local file.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

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
  macosKeychainBackend,
  resolveTokenStore,
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
      if (v === undefined) return Promise.reject(new Error("item not found")); // absent → nonzero
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
