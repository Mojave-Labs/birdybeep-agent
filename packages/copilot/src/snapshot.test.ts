import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { copilotBackupPath, generatedCopilotHooksText, installCopilot } from "./install";
import { copilotHooksPath } from "./paths";
import { uninstallCopilot } from "./uninstall";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function options(sb: Sandbox) {
  return { home: sb.home, env: {} };
}

describe("Copilot generated hook snapshot", () => {
  it("keeps the public generated-config example byte-for-byte current", () => {
    const example = readFileSync(
      new URL("../../../examples/copilot/birdybeep.json", import.meta.url),
      "utf8",
    );
    expect(example).toBe(generatedCopilotHooksText());
  });

  it("writes the exact dedicated hook file", async () => {
    sandbox = createSandbox();
    await installCopilot(options(sandbox));
    const output = readFileSync(copilotHooksPath(options(sandbox)), "utf8");
    expect(output).toMatchSnapshot();
    expect(output).not.toMatch(/bbm_|bearer |token["']?\s*:/i);
  });

  it("is idempotent and never touches a foreign hook file", async () => {
    sandbox = createSandbox();
    const foreign = join(sandbox.home, ".copilot", "hooks", "company-policy.json");
    mkdirSync(dirname(foreign), { recursive: true });
    const original = '{"version":1,"hooks":{"sessionStart":[]}}\n';
    writeFileSync(foreign, original);
    const first = await installCopilot(options(sandbox));
    const managed = readFileSync(copilotHooksPath(options(sandbox)), "utf8");
    const second = await installCopilot(options(sandbox));
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(readFileSync(copilotHooksPath(options(sandbox)), "utf8")).toBe(managed);
    expect(readFileSync(foreign, "utf8")).toBe(original);
  });

  it("backs up and restores a pre-existing dedicated path byte-for-byte", async () => {
    sandbox = createSandbox();
    const path = copilotHooksPath(options(sandbox));
    mkdirSync(dirname(path), { recursive: true });
    const original = '{\n  "company": true\n}\n';
    writeFileSync(path, original);
    const installed = await installCopilot(options(sandbox));
    expect(installed.backupFiles).toEqual([copilotBackupPath(path)]);
    const removed = await uninstallCopilot(options(sandbox));
    expect(removed.restoredFiles).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("from-scratch install then uninstall removes only BirdyBeep's file", async () => {
    sandbox = createSandbox();
    const foreign = join(sandbox.home, ".copilot", "hooks", "foreign.json");
    mkdirSync(dirname(foreign), { recursive: true });
    writeFileSync(foreign, "{}\n");
    await installCopilot(options(sandbox));
    const result = await uninstallCopilot(options(sandbox));
    expect(result.removedFiles).toEqual([copilotHooksPath(options(sandbox))]);
    expect(readFileSync(foreign, "utf8")).toBe("{}\n");
  });
});
