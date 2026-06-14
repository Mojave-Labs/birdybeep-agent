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
  resolveTokenStore,
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
