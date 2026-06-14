/**
 * CORE-FINGERPRINT proof: stability (same machine → same hash), non-reversibility
 * (raw signals never appear in the output), distinctness across machines, and
 * correct OS/label. The live wrangler-dev upsert-idempotency check is the deferred
 * cross-repo gate.
 */
import { describe, expect, it } from "vitest";

import {
  collectMachineSignals,
  fingerprintFromSignals,
  getMachineFingerprintHash,
  getMachineIdentity,
  getMachineLabel,
  getOS,
  type MachineSignals,
} from "./fingerprint";

const signalsA: MachineSignals = {
  hostname: "SECRET-HOSTNAME-alpha",
  platform: "darwin",
  arch: "arm64",
  cpuModel: "Apple M3 Pro",
  totalmem: 38_654_705_664,
  mac: "AA:BB:CC:DD:EE:FF",
};
const signalsB: MachineSignals = { ...signalsA, hostname: "other-box", mac: "11:22:33:44:55:66" };

describe("fingerprint hash", () => {
  it("is stable: same signals → same hash, repeated calls equal", () => {
    expect(fingerprintFromSignals(signalsA)).toBe(fingerprintFromSignals(signalsA));
    expect(getMachineFingerprintHash(signalsA)).toBe(getMachineFingerprintHash(signalsA));
  });

  it("is a sha256 hex digest, not a raw identifier", () => {
    expect(fingerprintFromSignals(signalsA)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs across distinct machines", () => {
    expect(fingerprintFromSignals(signalsA)).not.toBe(fingerprintFromSignals(signalsB));
  });

  it("never leaks a raw host signal (hostname / MAC) in the output", () => {
    const hash = fingerprintFromSignals(signalsA);
    expect(hash).not.toContain(signalsA.hostname);
    expect(hash).not.toContain("AA:BB:CC:DD:EE:FF");
  });

  it("collectMachineSignals() on the real host produces a usable, stable hash", () => {
    const a = getMachineFingerprintHash(collectMachineSignals());
    const b = getMachineFingerprintHash(collectMachineSignals());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });
});

describe("OS normalization", () => {
  it("maps the platform to the normalized value", () => {
    expect(getOS("darwin")).toBe("macos");
    expect(getOS("win32")).toBe("windows");
    expect(getOS("linux")).toBe("linux");
    expect(getOS("freebsd")).toBe("freebsd");
  });

  it("returns the correct value for the running CI OS", () => {
    const expected = { darwin: "macos", win32: "windows", linux: "linux" }[
      process.platform as "darwin" | "win32" | "linux"
    ];
    if (expected) expect(getOS()).toBe(expected);
  });
});

describe("machine label", () => {
  it("strips a trailing .local and is non-empty", () => {
    expect(getMachineLabel("MacBook-Pro.local")).toBe("MacBook-Pro");
    expect(getMachineLabel("devbox")).toBe("devbox");
    expect(getMachineLabel("").length).toBeGreaterThan(0); // falls back, never empty
  });

  it("the real machine label is non-empty", () => {
    expect(getMachineLabel().length).toBeGreaterThan(0);
  });
});

describe("machine identity shape", () => {
  it("returns label + os + fingerprintHash matching the event/upsert shape", () => {
    const id = getMachineIdentity();
    expect(id.label.length).toBeGreaterThan(0);
    expect(id.os.length).toBeGreaterThan(0);
    expect(id.fingerprintHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
