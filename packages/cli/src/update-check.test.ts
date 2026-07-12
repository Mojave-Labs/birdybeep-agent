/**
 * Passive update-notifier proof. Unit-tests {@link maybeNotifyUpdate}'s policy (cache TTL, the
 * hook/report-status/json/non-interactive/non-tty/env skips, offline fallback) with everything
 * injected — no real network, fs, clock, or TTY — plus one integration test through `runCli` that
 * proves the framework prints the notice on stderr AFTER a command runs and stays silent for the
 * `hook` hot path. Also covers the dependency-free semver comparison (§11 precedence).
 */
import { describe, expect, it, vi } from "vitest";

import { createIo, type GlobalFlags, runCli } from "./cli";
import { type Command, EXIT } from "./framework";
import {
  compareSemver,
  isNewer,
  maybeNotifyUpdate,
  type NotifyUpdateOptions,
  PACKAGE_NAME,
  parseSemver,
  type UpdateCache,
} from "./update-check";

const FLAGS: GlobalFlags = { json: false, nonInteractive: false, help: false, version: false };
const NOW = 1_000_000_000_000; // fixed epoch ms; well past any TTL boundary from 0

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}

/** An io + captured stdout/stderr, plus a base options object with safe test defaults. */
function harness(overrides: Partial<NotifyUpdateOptions> = {}): {
  out: ReturnType<typeof capture>;
  err: ReturnType<typeof capture>;
  opts: NotifyUpdateOptions;
} {
  const out = capture();
  const err = capture();
  const io = createIo(false, out.writer, err.writer);
  const opts: NotifyUpdateOptions = {
    command: "status",
    flags: FLAGS,
    io,
    currentVersion: "1.0.0",
    now: NOW,
    isTTY: true, // exercise the notice path deterministically
    env: {}, // no CI / opt-out leakage from the real environment
    ...overrides,
  };
  return { out, err, opts };
}

/** A fetch stub that returns the given `latest` manifest and counts calls. */
function registryStub(version: string): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchImpl = (() => {
    n += 1;
    return Promise.resolve(new Response(JSON.stringify({ version }), { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => n };
}

describe("maybeNotifyUpdate — notice", () => {
  it("prints the upgrade notice (stderr) from a FRESH cache without touching the network", async () => {
    const stub = registryStub("9.9.9");
    const writeCache = vi.fn();
    const { err, out, opts } = harness({
      fetchImpl: stub.fetchImpl,
      readCache: (): UpdateCache => ({ checkedAt: NOW - 1000, latest: "2.0.0" }), // fresh
      writeCache,
    });

    await maybeNotifyUpdate(opts);

    expect(stub.calls()).toBe(0); // fresh cache → no registry hit
    expect(writeCache).not.toHaveBeenCalled();
    expect(err.text()).toContain("a new version of birdybeep is available: 1.0.0 → 2.0.0");
    expect(err.text()).toContain(`npm install -g ${PACKAGE_NAME}@latest`);
    expect(out.text()).toBe(""); // never pollutes stdout
  });

  it("refreshes from the registry when the cache is stale, caches the result, then notices", async () => {
    const stub = registryStub("2.0.0");
    const writeCache = vi.fn();
    const { err, opts } = harness({
      fetchImpl: stub.fetchImpl,
      readCache: (): UpdateCache => ({ checkedAt: NOW - 25 * 60 * 60 * 1000, latest: null }), // stale
      writeCache,
    });

    await maybeNotifyUpdate(opts);

    expect(stub.calls()).toBe(1);
    expect(writeCache).toHaveBeenCalledWith({ checkedAt: NOW, latest: "2.0.0" });
    expect(err.text()).toContain("1.0.0 → 2.0.0");
  });

  it("refreshes when there is no cache at all", async () => {
    const stub = registryStub("2.0.0");
    const { err, opts } = harness({
      fetchImpl: stub.fetchImpl,
      readCache: () => null,
      writeCache: vi.fn(),
    });
    await maybeNotifyUpdate(opts);
    expect(stub.calls()).toBe(1);
    expect(err.text()).toContain("1.0.0 → 2.0.0");
  });

  it("stays silent when already up to date", async () => {
    const { err, opts } = harness({
      readCache: (): UpdateCache => ({ checkedAt: NOW - 1000, latest: "1.0.0" }),
      writeCache: vi.fn(),
    });
    await maybeNotifyUpdate(opts);
    expect(err.text()).toBe("");
  });

  it("falls back to the last-known version (and backs off) when the registry refresh fails", async () => {
    const fetchImpl = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const writeCache = vi.fn();
    const { err, opts } = harness({
      fetchImpl,
      readCache: (): UpdateCache => ({ checkedAt: NOW - 25 * 60 * 60 * 1000, latest: "2.0.0" }),
      writeCache,
    });
    await maybeNotifyUpdate(opts);
    // Keeps the known update visible, and stamps checkedAt to avoid hammering while offline.
    expect(writeCache).toHaveBeenCalledWith({ checkedAt: NOW, latest: "2.0.0" });
    expect(err.text()).toContain("1.0.0 → 2.0.0");
  });
});

describe("maybeNotifyUpdate — skips (no network, no notice)", () => {
  const newerFresh = (): UpdateCache => ({ checkedAt: NOW - 1000, latest: "2.0.0" });

  for (const command of ["hook", "report-status"]) {
    it(`skips the \`${command}\` command entirely`, async () => {
      const stub = registryStub("9.9.9");
      const { err, opts } = harness({ command, fetchImpl: stub.fetchImpl, readCache: newerFresh });
      await maybeNotifyUpdate(opts);
      expect(stub.calls()).toBe(0);
      expect(err.text()).toBe("");
    });
  }

  it("skips under --json", async () => {
    const { err, opts } = harness({ flags: { ...FLAGS, json: true }, readCache: newerFresh });
    await maybeNotifyUpdate(opts);
    expect(err.text()).toBe("");
  });

  it("skips under --non-interactive", async () => {
    const { err, opts } = harness({
      flags: { ...FLAGS, nonInteractive: true },
      readCache: newerFresh,
    });
    await maybeNotifyUpdate(opts);
    expect(err.text()).toBe("");
  });

  it("skips when stderr is not a TTY", async () => {
    const { err, opts } = harness({ isTTY: false, readCache: newerFresh });
    await maybeNotifyUpdate(opts);
    expect(err.text()).toBe("");
  });

  for (const key of ["CI", "NO_UPDATE_NOTIFIER", "BIRDYBEEP_NO_UPDATE_NOTIFIER"]) {
    it(`skips when ${key} is set`, async () => {
      const { err, opts } = harness({ env: { [key]: "1" }, readCache: newerFresh });
      await maybeNotifyUpdate(opts);
      expect(err.text()).toBe("");
    });
  }

  it("never throws even if the cache reader blows up", async () => {
    const { err, opts } = harness({
      readCache: () => {
        throw new Error("corrupt");
      },
    });
    await expect(maybeNotifyUpdate(opts)).resolves.toBeUndefined();
    expect(err.text()).toBe("");
  });
});

describe("runCli integration — the framework wires the notifier after a command", () => {
  const stubCommand = (name: string): Command => ({
    name,
    summary: `stub ${name}`,
    run: (ctx) => {
      ctx.io.line(`${name} ran`);
      return EXIT.OK;
    },
  });

  it("prints the notice on stderr after the command's stdout", async () => {
    const out = capture();
    const err = capture();
    const code = await runCli(["status"], {
      commands: [stubCommand("status")],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
      updateCheck: {
        isTTY: true,
        env: {},
        currentVersion: "1.0.0",
        now: NOW,
        readCache: (): UpdateCache => ({ checkedAt: NOW - 1000, latest: "2.0.0" }),
        writeCache: () => {},
      },
    });
    expect(code).toBe(EXIT.OK);
    expect(out.text()).toContain("status ran");
    expect(err.text()).toContain("a new version of birdybeep is available: 1.0.0 → 2.0.0");
  });

  it("stays silent for the hook hot path", async () => {
    const out = capture();
    const err = capture();
    await runCli(["hook"], {
      commands: [stubCommand("hook")],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
      updateCheck: {
        isTTY: true,
        env: {},
        currentVersion: "1.0.0",
        now: NOW,
        readCache: (): UpdateCache => ({ checkedAt: NOW - 1000, latest: "2.0.0" }),
        writeCache: () => {},
      },
    });
    expect(out.text()).toContain("hook ran");
    expect(err.text()).toBe(""); // hot path is never nagged
  });

  it("can be fully disabled with updateCheck:false", async () => {
    const out = capture();
    const err = capture();
    await runCli(["status"], {
      commands: [stubCommand("status")],
      stdout: out.writer,
      stderr: err.writer,
      ensureConfig: false,
      updateCheck: false,
    });
    expect(err.text()).toBe("");
  });
});

describe("semver comparison", () => {
  it("parses core + prerelease and rejects junk", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("v0.1.0")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: [] });
    expect(parseSemver("1.2.3-beta.1+build.5")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", "1"],
    });
    expect(parseSemver("nope")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
  });

  it("orders by major.minor.patch then prerelease precedence (semver §11)", () => {
    const cmp = (a: string, b: string): number => compareSemver(parseSemver(a)!, parseSemver(b)!);
    expect(cmp("1.2.3", "1.2.4")).toBe(-1);
    expect(cmp("2.0.0", "1.9.9")).toBe(1);
    expect(cmp("1.2.3", "1.2.3")).toBe(0);
    expect(cmp("1.0.0-alpha", "1.0.0")).toBe(-1); // release outranks prerelease
    expect(cmp("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1); // numeric, not lexical
  });

  it("isNewer is true only for a strictly-higher parseable latest", () => {
    expect(isNewer("1.0.0", "1.0.1")).toBe(true);
    expect(isNewer("1.0.0-beta.1", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("2.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "garbage")).toBe(false);
  });
});
