import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { DetectionResult } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { generatedCopilotHooks, installCopilot } from "./install";
import { copilotHooksPath } from "./paths";
import {
  configuredCopilotHookTimeoutSeconds,
  copilotDoctor,
  copilotStatus,
  copilotStatusReport,
} from "./status";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

const present =
  (version = "1.0.70"): (() => Promise<DetectionResult>) =>
  () =>
    Promise.resolve({ detected: true, version });
const absent: () => Promise<DetectionResult> = () => Promise.resolve({ detected: false });

function options(sb: Sandbox) {
  return { home: sb.home, env: {} };
}

describe("Copilot status + doctor", () => {
  it("reads the smallest configured BirdyBeep hook deadline", () => {
    sandbox = createSandbox();
    const path = copilotHooksPath(options(sandbox));
    mkdirSync(dirname(path), { recursive: true });
    const config = generatedCopilotHooks() as {
      hooks: Record<string, { timeoutSec: number }[]>;
    };
    config.hooks["sessionStart"]![0]!.timeoutSec = 8;
    config.hooks["sessionEnd"]![0]!.timeoutSec = 7;
    writeFileSync(path, JSON.stringify(config));
    expect(configuredCopilotHookTimeoutSeconds(options(sandbox))).toBe(7);
  });

  it("moves from unknown to installed and reports versions", async () => {
    sandbox = createSandbox();
    expect(await copilotStatus({ ...options(sandbox), detect: present() })).toBe("unknown");
    await installCopilot(options(sandbox));
    expect(await copilotStatus({ ...options(sandbox), detect: present() })).toBe("installed");
    expect(
      await copilotStatusReport({ ...options(sandbox), detect: present("9.9.9") }),
    ).toMatchObject({
      status: "installed",
      harnessVersion: "9.9.9",
    });
    expect((await copilotDoctor({ ...options(sandbox), detect: present() })).ok).toBe(true);
  });

  it("reports not_detected with an actionable remedy", async () => {
    sandbox = createSandbox();
    expect(await copilotStatus({ ...options(sandbox), detect: absent })).toBe("not_detected");
    const doctor = await copilotDoctor({ ...options(sandbox), detect: absent });
    expect(doctor.ok).toBe(false);
    expect(doctor.checks.find((check) => !check.ok)?.remedy).toMatch(/install/i);
  });

  it("reports error for malformed or drifted managed JSON", async () => {
    sandbox = createSandbox();
    const path = copilotHooksPath(options(sandbox));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ bad json");
    expect(await copilotStatus({ ...options(sandbox), detect: present() })).toBe("error");
    writeFileSync(path, '{"version":1,"hooks":{}}\n');
    expect(await copilotStatus({ ...options(sandbox), detect: present() })).toBe("error");
  });
});

/**
 * gcgp.9 parity (wired for gcgp.16): a launcher whose absolute paths have moved leaves the hook
 * file looking correctly installed while Copilot fails every hook with exit 127. The file carries
 * a bash AND a powershell form of the same launcher, so a shared path must be reported once.
 */
describe("Copilot doctor — hook command resolves", () => {
  const CHECK = "Hook command resolves";

  it("passes when the installed launcher's paths still exist", async () => {
    sandbox = createSandbox();
    const node = sandbox.path("node");
    const cli = sandbox.path("birdybeep.cjs");
    writeFileSync(node, "");
    writeFileSync(cli, "");
    await installCopilot({ ...options(sandbox), hookCommand: `"${node}" "${cli}"` });
    const r = await copilotDoctor({ ...options(sandbox), detect: present() });
    expect(r.checks.find((c) => c.name === CHECK)?.ok).toBe(true);
  });

  it("flags a moved CLI once, not once per shell form", async () => {
    sandbox = createSandbox();
    const gone = sandbox.path("moved-away", "birdybeep.cjs");
    await installCopilot({ ...options(sandbox), hookCommand: `"${gone}"` });
    const r = await copilotDoctor({ ...options(sandbox), detect: present() });
    const check = r.checks.find((c) => c.name === CHECK);
    expect(check?.ok).toBe(false);
    expect((check?.detail ?? "").split(gone).length - 1).toBe(1);
    expect(check?.remedy).toMatch(/birdybeep agent install copilot/);
  });
});
