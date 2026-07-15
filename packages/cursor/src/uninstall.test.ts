/**
 * CUR-UNINSTALL proof (hermetic temp HOME): install→uninstall returns a realistic config
 * byte-for-byte to its original; a co-existing user hook is preserved while BirdyBeep's is
 * removed; a from-scratch install (incl. the version scaffold) leaves no residue; and uninstall
 * with nothing installed (and a repeat) is a clean no-op.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  assertTreesEqual,
  captureTree,
  createSandbox,
  type Sandbox,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { installCursor } from "./install";
import { cursorHooksPath } from "./paths";
import { uninstallCursor } from "./uninstall";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function seed(path: string, value: unknown): string {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, raw);
  return raw;
}

describe("install → uninstall is a clean, byte-for-byte revert", () => {
  it("restores a realistic pre-existing config exactly, preserving a user hook", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    const original = {
      version: 1,
      hooks: {
        sessionStart: [{ command: "my-own-hook", timeout: 10 }],
      },
    };
    const originalRaw = seed(hooks, original);
    const before = captureTree(sandbox.path(".cursor"));

    await installCursor({}, sandbox.home);
    const r = await uninstallCursor({}, sandbox.home);
    expect(r.changed).toBe(true);
    expect(r.restoredFiles).toEqual([hooks]);

    // Byte-for-byte back to the original, and the user's hook survived intact.
    expect(readFileSync(hooks, "utf8")).toBe(originalRaw);
    assertTreesEqual(
      before,
      captureTree(sandbox.path(".cursor")),
      "uninstall restores the original",
    );
    expect(existsSync(`${hooks}.birdybeep-backup`)).toBe(false); // backup consumed
  });
});

describe("from-scratch install leaves no residue (incl. the version scaffold)", () => {
  it("removes the hooks file BirdyBeep created", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    await installCursor({}, sandbox.home); // creates hooks.json from scratch
    expect(existsSync(hooks)).toBe(true);
    const r = await uninstallCursor({}, sandbox.home);
    expect(r.removedFiles).toEqual([hooks]);
    expect(existsSync(hooks)).toBe(false); // no orphan { "version": 1 } left behind
  });
});

describe("idempotent no-op", () => {
  it("uninstall with nothing installed is a clean no-op", async () => {
    sandbox = createSandbox();
    const r = await uninstallCursor({}, sandbox.home);
    expect(r).toEqual({ changed: false, removedFiles: [], restoredFiles: [] });
  });

  it("a second uninstall after a real uninstall is a no-op", async () => {
    sandbox = createSandbox();
    seed(cursorHooksPath(sandbox.home), { version: 1, hooks: {} });
    await installCursor({}, sandbox.home);
    await uninstallCursor({}, sandbox.home);
    const second = await uninstallCursor({}, sandbox.home);
    expect(second.changed).toBe(false);
  });

  it("does not touch a config with no BirdyBeep entries", async () => {
    sandbox = createSandbox();
    const hooks = cursorHooksPath(sandbox.home);
    const raw = seed(hooks, {
      version: 1,
      hooks: { sessionStart: [{ command: "other", timeout: 5 }] },
    });
    const r = await uninstallCursor({}, sandbox.home);
    expect(r.changed).toBe(false);
    expect(readFileSync(hooks, "utf8")).toBe(raw); // untouched
  });
});
