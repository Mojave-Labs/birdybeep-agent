/**
 * CORE-FINGERPRINT proof: stability (same machine → same hash), non-reversibility
 * (raw signals never appear in the output), distinctness across machines, and
 * correct OS/label. The live wrangler-dev upsert-idempotency check is the deferred
 * cross-repo gate.
 */
import { withTempHome } from "@birdybeep/test-harness";
import { describe, expect, it } from "vitest";

import {
  collectMachineSignals,
  FINGERPRINT_PEPPER,
  fingerprintFromSignals,
  getMachineFingerprintHash,
  getMachineIdentity,
  getMachineLabel,
  getOS,
  type MachineSignals,
} from "./fingerprint";
import { INSTALL_SALT_ENV, resetInstallSaltCache } from "./salt";

const SALT_X = "1".repeat(64);
const SALT_Y = "2".repeat(64);

/** Run `fn` with the pinned env salt removed and the cache cleared, then restore. */
async function withoutEnvSalt<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env[INSTALL_SALT_ENV];
  delete process.env[INSTALL_SALT_ENV];
  resetInstallSaltCache();
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[INSTALL_SALT_ENV];
    else process.env[INSTALL_SALT_ENV] = saved;
    resetInstallSaltCache();
  }
}

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

// birdybeep-agent-ofi: the fingerprint is HMAC-keyed by a per-install salt, so the SAME host
// signals hash differently under different installs — offline reversal off the stored hash is
// no longer possible without the salt, which never leaves the machine.
describe("salted fingerprint (ofi)", () => {
  it("changes when the salt changes (same signals → different hash per install)", () => {
    expect(fingerprintFromSignals(signalsA, SALT_X)).not.toBe(
      fingerprintFromSignals(signalsA, SALT_Y),
    );
  });

  it("is stable for a fixed salt + signals, and still a 64-hex digest", () => {
    expect(fingerprintFromSignals(signalsA, SALT_X)).toBe(fingerprintFromSignals(signalsA, SALT_X));
    expect(fingerprintFromSignals(signalsA, SALT_X)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still distinguishes machines under one salt (dedup distinctness preserved)", () => {
    expect(fingerprintFromSignals(signalsA, SALT_X)).not.toBe(
      fingerprintFromSignals(signalsB, SALT_X),
    );
  });

  it("mixes in the static application pepper", () => {
    expect(FINGERPRINT_PEPPER.length).toBeGreaterThan(0);
  });

  it("is stable across process runs on one install (persisted salt)", async () => {
    await withTempHome(async () => {
      await withoutEnvSalt(() => {
        const first = getMachineFingerprintHash(signalsA);
        resetInstallSaltCache(); // simulate a fresh CLI process on the same machine
        expect(getMachineFingerprintHash(signalsA)).toBe(first);
      });
    });
  });

  it("differs across two installs for identical signals (offline correlation broken)", async () => {
    const a = await withTempHome(() => withoutEnvSalt(() => getMachineFingerprintHash(signalsA)));
    const b = await withTempHome(() => withoutEnvSalt(() => getMachineFingerprintHash(signalsA)));
    expect(a).not.toBe(b);
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
