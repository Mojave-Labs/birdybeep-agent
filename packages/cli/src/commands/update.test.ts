/**
 * `birdybeep update` proof: drive the real command through `runCli` against a stub npm registry
 * and assert it reports up-to-date vs. update-available correctly (human + --json), prints the
 * exact upgrade command only when behind, hits the right registry URL, and exits non-zero (with
 * a non-alarming message) when the registry check can't complete. Plus unit coverage of the
 * dependency-free semver comparison, including prerelease precedence per semver §11. Read-only:
 * the command never mutates anything, so no sandbox/token is needed.
 */
import { describe, expect, it } from "vitest";

import { runCli } from "../cli";
import { EXIT } from "../framework";
import { compareSemver, createUpdateCommand, PACKAGE_NAME, parseSemver } from "./update";

function capture(): { writer: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => chunks.push(s) }, text: () => chunks.join("") };
}

/** A fetch stub that records the URL it was asked for and returns the `latest` manifest. */
function registryStub(
  version: string,
  opts: { status?: number; body?: string } = {},
): { fetchImpl: typeof fetch; lastUrl: () => string | undefined } {
  let seen: string | undefined;
  const fetchImpl = ((url: string | URL) => {
    seen = String(url);
    const body = opts.body ?? JSON.stringify({ name: PACKAGE_NAME, version });
    return Promise.resolve(new Response(body, { status: opts.status ?? 200 }));
  }) as unknown as typeof fetch;
  return { fetchImpl, lastUrl: () => seen };
}

interface UpdateJson {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  upgradeCommand?: string;
  error?: string;
}

describe("birdybeep update", () => {
  it("reports an available upgrade with the exact command (human + hits the right registry URL)", async () => {
    const stub = registryStub("1.4.0");
    const cmd = createUpdateCommand({
      fetchImpl: stub.fetchImpl,
      currentVersion: "1.2.3",
      registryUrl: "https://registry.example.test/",
    });
    const out = capture();
    const code = await runCli(["update"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    const text = out.text();
    expect(text).toContain("1.2.3 → 1.4.0");
    expect(text).toContain(`npm install -g ${PACKAGE_NAME}@latest`);
    // Trailing slash on the registry is normalized; scoped name is URL-encoded; hits /latest.
    expect(stub.lastUrl()).toBe("https://registry.example.test/@birdybeep%2Fcli/latest");
  });

  it("mirrors updateAvailable + upgradeCommand under --json", async () => {
    const stub = registryStub("2.0.0");
    const cmd = createUpdateCommand({ fetchImpl: stub.fetchImpl, currentVersion: "1.9.9" });
    const out = capture();
    const code = await runCli(["update", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });

    expect(code).toBe(EXIT.OK);
    const json = JSON.parse(out.text()) as UpdateJson;
    expect(json).toMatchObject({
      current: "1.9.9",
      latest: "2.0.0",
      updateAvailable: true,
      upgradeCommand: `npm install -g ${PACKAGE_NAME}@latest`,
    });
  });

  it("says you're on the latest version when current === latest (no upgradeCommand in --json)", async () => {
    const stub = registryStub("1.2.3");
    const cmd = createUpdateCommand({ fetchImpl: stub.fetchImpl, currentVersion: "1.2.3" });
    const out = capture();
    const code = await runCli(["update"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(out.text()).toContain("1.2.3 is the latest version");

    const jsonOut = capture();
    await runCli(["update", "--json"], {
      commands: [createUpdateCommand({ fetchImpl: stub.fetchImpl, currentVersion: "1.2.3" })],
      stdout: jsonOut.writer,
      stderr: jsonOut.writer,
      ensureConfig: false,
    });
    const json = JSON.parse(jsonOut.text()) as UpdateJson;
    expect(json.updateAvailable).toBe(false);
    expect(json.upgradeCommand).toBeUndefined();
  });

  it("treats a running prerelease as behind the published release", async () => {
    const stub = registryStub("1.0.0");
    const cmd = createUpdateCommand({ fetchImpl: stub.fetchImpl, currentVersion: "1.0.0-beta.2" });
    const out = capture();
    const code = await runCli(["update", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect((JSON.parse(out.text()) as UpdateJson).updateAvailable).toBe(true);
  });

  it("does not offer an upgrade when the running version is ahead of the registry", async () => {
    const stub = registryStub("1.0.0");
    const cmd = createUpdateCommand({ fetchImpl: stub.fetchImpl, currentVersion: "1.1.0" });
    const out = capture();
    const code = await runCli(["update", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.OK);
    expect((JSON.parse(out.text()) as UpdateJson).updateAvailable).toBe(false);
  });

  it("exits non-zero with a non-alarming message when the registry is unreachable", async () => {
    const fetchImpl = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    const cmd = createUpdateCommand({ fetchImpl, currentVersion: "1.2.3" });
    const out = capture();
    const code = await runCli(["update"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    expect(out.text()).toContain("Couldn't check for updates");
    expect(out.text()).toContain("1.2.3"); // still tells you what you have
  });

  it("exits non-zero on a non-OK registry response (--json carries the error)", async () => {
    const stub = registryStub("", { status: 404, body: "Not Found" });
    const cmd = createUpdateCommand({ fetchImpl: stub.fetchImpl, currentVersion: "1.2.3" });
    const out = capture();
    const code = await runCli(["update", "--json"], {
      commands: [cmd],
      stdout: out.writer,
      stderr: out.writer,
      ensureConfig: false,
    });
    expect(code).toBe(EXIT.ERROR);
    const json = JSON.parse(out.text()) as UpdateJson;
    expect(json.updateAvailable).toBe(false);
    expect(json.latest).toBeNull();
    expect(json.error).toMatch(/404/);
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
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
  });

  it("orders by major.minor.patch then prerelease precedence (semver §11)", () => {
    const cmp = (a: string, b: string): number => compareSemver(parseSemver(a)!, parseSemver(b)!);
    expect(cmp("1.2.3", "1.2.4")).toBe(-1);
    expect(cmp("1.3.0", "1.2.9")).toBe(1);
    expect(cmp("2.0.0", "1.9.9")).toBe(1);
    expect(cmp("1.2.3", "1.2.3")).toBe(0);
    // A release outranks any prerelease of the same core version.
    expect(cmp("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(cmp("1.0.0", "1.0.0-alpha")).toBe(1);
    // Prerelease identifier precedence: numeric < alphanumeric, then length.
    expect(cmp("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(cmp("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(cmp("1.0.0-beta", "1.0.0-beta.2")).toBe(-1);
    expect(cmp("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1); // numeric, not lexical
  });
});
