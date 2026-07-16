/**
 * CUR-SNAPSHOT (§21.1 / §16.4): lock the EXACT Cursor hooks.json BirdyBeep generates and
 * prove non-destructive patching against realistic hooks.json shapes. If the generator drifts
 * or Cursor's hooks format changes, these committed snapshots fail loudly. Deterministic config
 * only — no live delivery (that's CUR-E2E). Also asserts NO token/secret is ever written.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
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
async function installAndRead(sb: Sandbox): Promise<string> {
  await installCursor({}, sb.home);
  return readFileSync(cursorHooksPath(sb.home), "utf8");
}
function expectNoSecrets(content: string): void {
  expect(content.toLowerCase()).not.toContain("bearer ");
  expect(content).not.toMatch(/bbm_|token["']?\s*[:=]\s*["']\S/i);
}

describe("generated config snapshots (§21.1)", () => {
  it("from-scratch install writes the canonical BirdyBeep hooks block", async () => {
    sandbox = createSandbox();
    const out = await installAndRead(sandbox);
    expect(out).toMatchSnapshot();
    expectNoSecrets(out);
  });

  it("patches into an existing config with a same-event user hook", async () => {
    sandbox = createSandbox();
    seed(cursorHooksPath(sandbox.home), {
      version: 1,
      hooks: { sessionStart: [{ command: "my-own-hook", timeout: 10 }] },
    });
    const out = await installAndRead(sandbox);
    expect(out).toMatchSnapshot();
    expectNoSecrets(out);
  });

  it("patches into an existing config that carries extra top-level keys", async () => {
    sandbox = createSandbox();
    seed(cursorHooksPath(sandbox.home), {
      version: 1,
      settings: { audit: true },
    });
    const out = await installAndRead(sandbox);
    expect(out).toMatchSnapshot();
    expectNoSecrets(out);
  });

  it("double-install is idempotent (second output identical to first)", async () => {
    sandbox = createSandbox();
    const first = await installAndRead(sandbox);
    await installCursor({}, sandbox.home);
    expect(readFileSync(cursorHooksPath(sandbox.home), "utf8")).toBe(first);
  });

  it("install → uninstall returns to the original fixture byte-for-byte", async () => {
    sandbox = createSandbox();
    const original = seed(cursorHooksPath(sandbox.home), {
      version: 1,
      hooks: { sessionStart: [{ command: "my-own-hook", timeout: 10 }] },
    });
    await installCursor({}, sandbox.home);
    await uninstallCursor({}, sandbox.home);
    expect(readFileSync(cursorHooksPath(sandbox.home), "utf8")).toBe(original);
  });
});
