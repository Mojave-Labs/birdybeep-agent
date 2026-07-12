import { defineConfig } from "vitest/config";

/**
 * Shared test config for every package that exercises path-hashing / the machine fingerprint.
 *
 * Pins a deterministic per-install salt (birdybeep-agent-ofi) via the BIRDYBEEP_INSTALL_SALT
 * override. Two reasons this MUST be set for unit tests:
 *   1. Reproducibility — hashes are stable run-to-run without depending on a generated salt.
 *   2. Sandbox safety — with the override present, the salt code never reads or CREATES the
 *      real per-install salt file in the developer's data dir (the project's cardinal rule:
 *      tests never touch the real machine). Tests that specifically prove salt PERSISTENCE
 *      clear this override inside a hermetic temp HOME (see agent-core/src/salt.test.ts).
 */
export default defineConfig({
  test: {
    env: {
      BIRDYBEEP_INSTALL_SALT: "0".repeat(64),
    },
  },
});
