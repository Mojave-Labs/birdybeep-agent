/**
 * birdybeep-agent-ofi proof: the per-install salt is (1) persisted so it stays stable across
 * process runs (path hashes correlate, the machine fingerprint dedups), (2) per-install random
 * so two installs get different salts (offline reversal off the DB is defeated), (3) overridable
 * via env for CI/E2E pinning, and (4) fails LOUDLY when it cannot persist — never silently
 * ephemeral for the fingerprint, which would mint a duplicate machine every run.
 *
 * NB: agent-core's vitest config pins BIRDYBEEP_INSTALL_SALT globally so the rest of the suite
 * hashes deterministically without touching the real data dir. These tests deliberately clear
 * that override inside a hermetic temp HOME to exercise the real file-persistence code path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { withTempHome } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import { birdyBeepDataDir } from "./paths";
import {
  getInstallSalt,
  getPersistedInstallSalt,
  INSTALL_SALT_ENV,
  installSaltPath,
  resetInstallSaltCache,
} from "./salt";

/** Run `fn` with the global env override removed and the process cache cleared, then restore. */
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

afterEach(() => {
  resetInstallSaltCache();
});

describe("install salt — env override", () => {
  it("uses BIRDYBEEP_INSTALL_SALT when set (CI/E2E pin), no file I/O", () => {
    const saved = process.env[INSTALL_SALT_ENV];
    process.env[INSTALL_SALT_ENV] = "abcdef0123456789".repeat(4);
    resetInstallSaltCache();
    try {
      expect(getInstallSalt()).toBe("abcdef0123456789".repeat(4));
      expect(getPersistedInstallSalt()).toBe("abcdef0123456789".repeat(4));
    } finally {
      if (saved === undefined) delete process.env[INSTALL_SALT_ENV];
      else process.env[INSTALL_SALT_ENV] = saved;
      resetInstallSaltCache();
    }
  });

  it("ignores a malformed override and falls through to persistence", async () => {
    await withTempHome(() => {
      const saved = process.env[INSTALL_SALT_ENV];
      process.env[INSTALL_SALT_ENV] = "not-hex-too-short";
      resetInstallSaltCache();
      try {
        const salt = getInstallSalt();
        expect(salt).not.toBe("not-hex-too-short");
        expect(salt).toMatch(/^[0-9a-f]{64}$/);
        expect(existsSync(installSaltPath())).toBe(true); // persisted, since override was rejected
      } finally {
        if (saved === undefined) delete process.env[INSTALL_SALT_ENV];
        else process.env[INSTALL_SALT_ENV] = saved;
        resetInstallSaltCache();
      }
    });
  });
});

describe("install salt — persistence & stability", () => {
  it("creates a 32-byte hex salt file in the data dir on first use", async () => {
    await withTempHome(async () => {
      await withoutEnvSalt(() => {
        const salt = getInstallSalt();
        expect(salt).toMatch(/^[0-9a-f]{64}$/); // 32 bytes
        expect(existsSync(installSaltPath())).toBe(true);
        expect(readFileSync(installSaltPath(), "utf8").trim()).toBe(salt);
      });
    });
  });

  it("is stable across process runs: a fresh read returns the SAME persisted salt", async () => {
    await withTempHome(async () => {
      await withoutEnvSalt(() => {
        const first = getInstallSalt();
        resetInstallSaltCache(); // simulate a brand-new hook process on the same machine
        const second = getInstallSalt();
        expect(second).toBe(first);
      });
    });
  });

  it("does not rewrite the file once it exists (adopts the persisted value)", async () => {
    await withTempHome(async () => {
      await withoutEnvSalt(() => {
        getInstallSalt();
        const path = installSaltPath();
        const pinned = "deadbeef".repeat(8); // 64 hex, valid shape
        writeFileSync(path, pinned, "utf8");
        resetInstallSaltCache();
        expect(getInstallSalt()).toBe(pinned);
      });
    });
  });

  it("is per-install: two independent installs get different salts", async () => {
    const a = await withTempHome(() => withoutEnvSalt(() => getInstallSalt()));
    const b = await withTempHome(() => withoutEnvSalt(() => getInstallSalt()));
    expect(a).not.toBe(b);
  });
});

describe("install salt — loud failure when it cannot persist", () => {
  it("getPersistedInstallSalt throws rather than hand back an ephemeral salt", async () => {
    await withTempHome(async () => {
      await withoutEnvSalt(() => {
        // Make the data dir un-creatable by planting a FILE where the directory must be.
        const dataDir = birdyBeepDataDir();
        mkdirSync(dirname(dataDir), { recursive: true });
        writeFileSync(dataDir, "not a directory", "utf8");

        // getInstallSalt stays private and non-throwing (ephemeral fallback keeps the harness alive)…
        expect(getInstallSalt()).toMatch(/^[0-9a-f]{64}$/);
        // …but the stability-critical accessor refuses to pretend it persisted.
        expect(() => getPersistedInstallSalt()).toThrow(/could not persist/i);
      });
    });
  });
});
