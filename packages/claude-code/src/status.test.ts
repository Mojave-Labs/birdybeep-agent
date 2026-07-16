/**
 * CC-STATUS-DOCTOR proof (hermetic temp HOME; detection injected so no `claude`
 * binary is shelled out): status() across installed / not_detected / error / unknown,
 * and doctor() flagging each seeded failure mode with an actionable fix. statusReport
 * carries harness + adapter versions.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { DetectionResult } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { installClaudeCode } from "./install";
import { claudeSettingsPath } from "./paths";
import {
  CLAUDE_CODE_ADAPTER_VERSION,
  claudeCodeDoctor,
  claudeCodeStatus,
  claudeCodeStatusReport,
} from "./status";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

const present = (version = "1.2.3"): (() => Promise<DetectionResult>) => {
  return () => Promise.resolve({ detected: true, version, configPath: "x" });
};
const absent: () => Promise<DetectionResult> = () => Promise.resolve({ detected: false });

const POSIX = process.platform !== "win32";
/**
 * Root bypasses discretionary file permissions, so a 0o444 file still passes the
 * `W_OK` access check — the read-only-file scenario simply cannot be reproduced as
 * root (common in CI/containers). Skip those cases there, same spirit as `!POSIX`.
 */
const ROOT = POSIX && typeof process.getuid === "function" && process.getuid() === 0;

describe("status()", () => {
  it("is `installed` when Claude Code is present and all hooks are registered", async () => {
    sandbox = createSandbox();
    await installClaudeCode({}, sandbox.home);
    expect(await claudeCodeStatus({ home: sandbox.home, detect: present() })).toBe("installed");
  });

  it("is `not_detected` when Claude Code is absent", async () => {
    sandbox = createSandbox();
    expect(await claudeCodeStatus({ home: sandbox.home, detect: absent })).toBe("not_detected");
  });

  it("is `unknown` when Claude Code is present but BirdyBeep is not installed", async () => {
    sandbox = createSandbox();
    writeFileSync(seedDir(sandbox), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
    expect(await claudeCodeStatus({ home: sandbox.home, detect: present() })).toBe("unknown");
  });

  it("is `error` when settings.json is corrupt", async () => {
    sandbox = createSandbox();
    writeFileSync(seedDir(sandbox), "{ this is not json");
    expect(await claudeCodeStatus({ home: sandbox.home, detect: present() })).toBe("error");
  });

  it("is `error` when only some hooks are installed (partial)", async () => {
    sandbox = createSandbox();
    await installClaudeCode({}, sandbox.home);
    // Remove one event's BirdyBeep entry to simulate a partial install.
    const path = claudeSettingsPath(sandbox.home);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { hooks: Record<string, unknown> };
    delete parsed.hooks["SessionStart"];
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    expect(await claudeCodeStatus({ home: sandbox.home, detect: present() })).toBe("error");
  });
});

describe("statusReport()", () => {
  it("includes the harness + adapter versions", async () => {
    sandbox = createSandbox();
    await installClaudeCode({}, sandbox.home);
    const report = await claudeCodeStatusReport({ home: sandbox.home, detect: present("9.9.9") });
    expect(report.status).toBe("installed");
    expect(report.harnessVersion).toBe("9.9.9");
    expect(report.adapterVersion).toBe(CLAUDE_CODE_ADAPTER_VERSION);
  });
});

function failingCheck(checks: { name: string; ok: boolean; remedy?: string }[], namePart: string) {
  return checks.find((c) => !c.ok && c.name.includes(namePart));
}

describe("doctor()", () => {
  it("reports healthy when fully installed", async () => {
    sandbox = createSandbox();
    await installClaudeCode({}, sandbox.home);
    const result = await claudeCodeDoctor({ home: sandbox.home, detect: present() });
    expect(result.ok).toBe(true);
  });

  it("flags Claude Code not installed with a fix", async () => {
    sandbox = createSandbox();
    const result = await claudeCodeDoctor({ home: sandbox.home, detect: absent });
    const check = failingCheck(result.checks, "Claude Code installed");
    expect(check).toBeDefined();
    expect(check?.remedy).toMatch(/install/i);
  });

  it("flags missing BirdyBeep hooks with a re-install fix", async () => {
    sandbox = createSandbox();
    writeFileSync(seedDir(sandbox), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
    const result = await claudeCodeDoctor({ home: sandbox.home, detect: present() });
    const check = failingCheck(result.checks, "BirdyBeep hooks");
    expect(check).toBeDefined();
    expect(check?.remedy).toMatch(/install claude/i);
  });

  it("flags a corrupt settings.json with a remediation", async () => {
    sandbox = createSandbox();
    writeFileSync(seedDir(sandbox), "{ not json");
    const result = await claudeCodeDoctor({ home: sandbox.home, detect: present() });
    const check = failingCheck(result.checks, "valid JSON");
    expect(check).toBeDefined();
    expect(check?.remedy).toBeDefined();
  });

  it("flags a read-only settings file (POSIX)", async () => {
    if (!POSIX || ROOT) return; // root bypasses 0o444 → the not-writable case is unreachable
    sandbox = createSandbox();
    await installClaudeCode({}, sandbox.home);
    const path = claudeSettingsPath(sandbox.home);
    chmodSync(path, 0o444);
    const result = await claudeCodeDoctor({ home: sandbox.home, detect: present() });
    const check = failingCheck(result.checks, "writable");
    expect(check).toBeDefined();
    expect(check?.remedy).toMatch(/permission/i);
    chmodSync(path, 0o644); // restore so cleanup can remove it
  });
});

/** Create ~/.claude in the sandbox and return the settings path to write. */
function seedDir(sb: Sandbox): string {
  mkdirSync(sb.path(".claude"), { recursive: true });
  return claudeSettingsPath(sb.home);
}
