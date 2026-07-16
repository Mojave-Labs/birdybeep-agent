/**
 * CUR-STATUS-DOCTOR proof (hermetic temp HOME; detection injected so no `cursor-agent` binary
 * is shelled out): status() across installed / not_detected / error / unknown, and doctor()
 * flagging each seeded failure mode with an actionable fix. Cursor has NO trust/restart gate, so
 * `installed` is reported the moment the entries are present. statusReport carries versions.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { DetectionResult } from "@birdybeep/agent-core";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { installCursor } from "./install";
import { cursorHooksPath } from "./paths";
import { CURSOR_ADAPTER_VERSION, cursorDoctor, cursorStatus, cursorStatusReport } from "./status";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

const present = (version = "2026.07.09"): (() => Promise<DetectionResult>) => {
  return () => Promise.resolve({ detected: true, version, configPath: "x" });
};
const absent: () => Promise<DetectionResult> = () => Promise.resolve({ detected: false });

const POSIX = process.platform !== "win32";
/** Root bypasses discretionary file permissions, so a 0o444 file still passes W_OK — skip there. */
const ROOT = POSIX && typeof process.getuid === "function" && process.getuid() === 0;

describe("status()", () => {
  it("is `installed` (immediately — no trust/restart gate) when present + all hooks registered", async () => {
    sandbox = createSandbox();
    await installCursor({}, sandbox.home);
    expect(await cursorStatus({ home: sandbox.home, detect: present() })).toBe("installed");
  });

  it("is `not_detected` when Cursor is absent", async () => {
    sandbox = createSandbox();
    expect(await cursorStatus({ home: sandbox.home, detect: absent })).toBe("not_detected");
  });

  it("is `unknown` when Cursor is present but BirdyBeep is not installed", async () => {
    sandbox = createSandbox();
    writeFileSync(seedDir(sandbox), `${JSON.stringify({ version: 1 }, null, 2)}\n`);
    expect(await cursorStatus({ home: sandbox.home, detect: present() })).toBe("unknown");
  });

  it("is `error` when hooks.json is corrupt", async () => {
    sandbox = createSandbox();
    writeFileSync(seedDir(sandbox), "{ this is not json");
    expect(await cursorStatus({ home: sandbox.home, detect: present() })).toBe("error");
  });

  it("is `error` when only some hooks are installed (partial)", async () => {
    sandbox = createSandbox();
    await installCursor({}, sandbox.home);
    // Remove one event's BirdyBeep entry to simulate a partial install.
    const path = cursorHooksPath(sandbox.home);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { hooks: Record<string, unknown> };
    delete parsed.hooks["sessionStart"];
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    expect(await cursorStatus({ home: sandbox.home, detect: present() })).toBe("error");
  });
});

describe("statusReport()", () => {
  it("includes the harness + adapter versions", async () => {
    sandbox = createSandbox();
    await installCursor({}, sandbox.home);
    const report = await cursorStatusReport({ home: sandbox.home, detect: present("9.9.9") });
    expect(report.status).toBe("installed");
    expect(report.harnessVersion).toBe("9.9.9");
    expect(report.adapterVersion).toBe(CURSOR_ADAPTER_VERSION);
  });
});

function failingCheck(checks: { name: string; ok: boolean; remedy?: string }[], namePart: string) {
  return checks.find((c) => !c.ok && c.name.includes(namePart));
}

describe("doctor()", () => {
  it("reports healthy when fully installed", async () => {
    sandbox = createSandbox();
    await installCursor({}, sandbox.home);
    const result = await cursorDoctor({ home: sandbox.home, detect: present() });
    expect(result.ok).toBe(true);
  });

  it("flags Cursor not installed with a fix", async () => {
    sandbox = createSandbox();
    const result = await cursorDoctor({ home: sandbox.home, detect: absent });
    const check = failingCheck(result.checks, "Cursor installed");
    expect(check).toBeDefined();
    expect(check?.remedy).toMatch(/install/i);
  });

  it("flags missing BirdyBeep hooks with a re-install fix", async () => {
    sandbox = createSandbox();
    writeFileSync(seedDir(sandbox), `${JSON.stringify({ version: 1 }, null, 2)}\n`);
    const result = await cursorDoctor({ home: sandbox.home, detect: present() });
    const check = failingCheck(result.checks, "BirdyBeep hooks");
    expect(check).toBeDefined();
    expect(check?.remedy).toMatch(/install cursor/i);
  });

  it("flags a corrupt hooks.json with a remediation", async () => {
    sandbox = createSandbox();
    writeFileSync(seedDir(sandbox), "{ not json");
    const result = await cursorDoctor({ home: sandbox.home, detect: present() });
    const check = failingCheck(result.checks, "valid JSON");
    expect(check).toBeDefined();
    expect(check?.remedy).toBeDefined();
  });

  it("flags a read-only hooks file (POSIX)", async () => {
    if (!POSIX || ROOT) return; // root bypasses 0o444 → the not-writable case is unreachable
    sandbox = createSandbox();
    await installCursor({}, sandbox.home);
    const path = cursorHooksPath(sandbox.home);
    chmodSync(path, 0o444);
    const result = await cursorDoctor({ home: sandbox.home, detect: present() });
    const check = failingCheck(result.checks, "writable");
    expect(check).toBeDefined();
    expect(check?.remedy).toMatch(/permission/i);
    chmodSync(path, 0o644); // restore so cleanup can remove it
  });
});

/** Create ~/.cursor in the sandbox and return the hooks path to write. */
function seedDir(sb: Sandbox): string {
  mkdirSync(sb.path(".cursor"), { recursive: true });
  return cursorHooksPath(sb.home);
}
