import { existsSync, mkdirSync } from "node:fs";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { detectCopilot } from "./detect";
import { copilotHooksPath } from "./paths";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

describe("detectCopilot", () => {
  it("detects the config directory and reports the probed version", async () => {
    sandbox = createSandbox();
    mkdirSync(sandbox.path(".copilot"), { recursive: true });
    const result = await detectCopilot({
      home: sandbox.home,
      env: {},
      probeVersion: () => Promise.resolve("1.0.70"),
    });
    expect(result).toEqual({
      detected: true,
      version: "1.0.70",
      configPath: copilotHooksPath({ home: sandbox.home, env: {} }),
    });
  });

  it("detects a binary without a config directory", async () => {
    sandbox = createSandbox();
    const result = await detectCopilot({
      home: sandbox.home,
      env: {},
      probeVersion: () => Promise.resolve("1.0.70"),
    });
    expect(result.detected).toBe(true);
  });

  it("is absent without a binary or config and creates nothing", async () => {
    sandbox = createSandbox();
    const result = await detectCopilot({
      home: sandbox.home,
      env: {},
      probeVersion: () => Promise.resolve(null),
    });
    expect(result.detected).toBe(false);
    expect(existsSync(sandbox.path(".copilot"))).toBe(false);
  });

  it("honors COPILOT_HOME", async () => {
    sandbox = createSandbox();
    const configured = sandbox.path("custom-copilot-home");
    mkdirSync(configured, { recursive: true });
    const result = await detectCopilot({
      home: sandbox.home,
      env: { COPILOT_HOME: configured },
      probeVersion: () => Promise.resolve(null),
    });
    expect(result.configPath).toBe(`${configured}/hooks/birdybeep.json`);
  });
});
