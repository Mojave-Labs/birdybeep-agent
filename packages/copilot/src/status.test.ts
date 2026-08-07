import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { DetectionResult } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { installCopilot } from "./install";
import { copilotHooksPath } from "./paths";
import { copilotDoctor, copilotStatus, copilotStatusReport } from "./status";

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
