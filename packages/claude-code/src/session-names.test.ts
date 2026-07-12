/**
 * SessionNameStore proof (sv1): the disk-backed session_id → name cache that lets a later
 * Stop lead its push title with the /rename'd session NAME. Hermetic (sandbox dir, injected
 * clock); asserts round-trip, TTL expiry, SessionEnd cleanup, strict perms, corrupt/absent
 * tolerance, and the fail-soft contract (never throws into the hook).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanSessionName, SESSION_NAME_MAX_CHARS, SessionNameStore } from "./session-names";

const dirs: string[] = [];
function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "bb-sns-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("cleanSessionName", () => {
  it("collapses whitespace and trims", () => {
    expect(cleanSessionName("  billing   refactor \n")).toBe("billing refactor");
  });
  it("returns undefined for blank/non-string", () => {
    expect(cleanSessionName("   ")).toBeUndefined();
    expect(cleanSessionName("")).toBeUndefined();
    expect(cleanSessionName(undefined)).toBeUndefined();
    expect(cleanSessionName(42)).toBeUndefined();
  });
  it("truncates a pathologically long name with an ellipsis", () => {
    const long = "x".repeat(SESSION_NAME_MAX_CHARS + 50);
    const cleaned = cleanSessionName(long)!;
    expect(cleaned.length).toBe(SESSION_NAME_MAX_CHARS);
    expect(cleaned.endsWith("…")).toBe(true);
  });
});

describe("SessionNameStore", () => {
  it("round-trips a name by session id", () => {
    const store = new SessionNameStore({ dir: sandbox() });
    store.remember("sess-1", "billing refactor");
    expect(store.lookup("sess-1")).toBe("billing refactor");
    expect(store.lookup("sess-UNKNOWN")).toBeUndefined();
  });

  it("forget() removes an entry (SessionEnd cleanup)", () => {
    const dir = sandbox();
    const store = new SessionNameStore({ dir });
    store.remember("sess-1", "gone soon");
    expect(readdirSync(dir).length).toBe(1);
    store.forget("sess-1");
    expect(store.lookup("sess-1")).toBeUndefined();
    expect(readdirSync(dir).length).toBe(0);
  });

  it("expires entries past the TTL and prunes them on read", () => {
    const dir = sandbox();
    let clock = 1_000;
    const store = new SessionNameStore({ dir, ttlMs: 100, now: () => clock });
    store.remember("sess-1", "stale");
    clock += 101;
    expect(store.lookup("sess-1")).toBeUndefined(); // expired
    expect(readdirSync(dir).length).toBe(0); // pruned on read
  });

  it("sweeps other-session expired entries on the next write (no unbounded growth)", () => {
    const dir = sandbox();
    let clock = 1_000;
    const store = new SessionNameStore({ dir, ttlMs: 100, now: () => clock });
    store.remember("old", "ancient");
    clock += 500; // "old" is now well past its TTL
    store.remember("new", "fresh"); // this write sweeps
    const names = readdirSync(dir);
    expect(names.length).toBe(1); // only "new" survives
    expect(store.lookup("new")).toBe("fresh");
  });

  it("writes strict perms: dir 0700, file 0600 (POSIX)", () => {
    if (process.platform === "win32") return; // ACL-based; perms bits are meaningless
    const dir = sandbox();
    const store = new SessionNameStore({ dir });
    store.remember("sess-1", "secret-ish");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = readdirSync(dir).find((n) => n.endsWith(".json"))!;
    expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    expect(store.isSecure()).toBe(true);
  });

  it("does not store the raw session id in the filename (hashed)", () => {
    const dir = sandbox();
    const store = new SessionNameStore({ dir });
    store.remember("super-secret-session-id", "n");
    const names = readdirSync(dir).join(" ");
    expect(names).not.toContain("super-secret-session-id");
    expect(names).toMatch(/^[0-9a-f]{32}\.json$/);
  });

  it("tolerates a corrupt file: lookup returns undefined, no throw", () => {
    const dir = sandbox();
    const store = new SessionNameStore({ dir });
    store.remember("sess-1", "ok");
    const file = join(dir, readdirSync(dir).find((n) => n.endsWith(".json"))!);
    writeFileSync(file, "{ not json");
    expect(() => store.lookup("sess-1")).not.toThrow();
    expect(store.lookup("sess-1")).toBeUndefined();
  });

  it("is fail-soft when the state dir is unusable (a file, not a dir): no throw", () => {
    const root = sandbox();
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "i am a file");
    const store = new SessionNameStore({ dir: blocked });
    expect(store.remember("sess-1", "x")).toBe(false); // reports failure, never throws
    expect(() => store.lookup("sess-1")).not.toThrow();
    expect(store.lookup("sess-1")).toBeUndefined();
    expect(() => store.forget("sess-1")).not.toThrow();
  });

  it("persists a compact JSON shape { name, updatedAt }", () => {
    const dir = sandbox();
    const store = new SessionNameStore({ dir, now: () => 12345 });
    store.remember("sess-1", "hello");
    const file = join(dir, readdirSync(dir).find((n) => n.endsWith(".json"))!);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ name: "hello", updatedAt: 12345 });
  });
});
