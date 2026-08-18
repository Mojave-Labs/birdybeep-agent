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
 *
 * Also BLANKS the env vars adapters read `harness_version` from (birdybeep-agent-gcgp.7).
 * These suites are routinely run from inside one of the very harnesses under test — a developer
 * running `pnpm test` inside Claude Code inherits `AI_AGENT=claude-code_<version>_…`, which
 * would silently add a `harness_version` to every normalized event locally and not in CI. Tests
 * that exercise the version read inject their own `env` (unit) or `vi.stubEnv` (E2E).
 */
export default defineConfig({
  test: {
    env: {
      BIRDYBEEP_INSTALL_SALT: "0".repeat(64),
      AI_AGENT: "",
      CLAUDE_CODE_EXECPATH: "",
      COPILOT_CLI_BINARY_VERSION: "",
    },
  },
});
