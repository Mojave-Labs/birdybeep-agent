/**
 * examples/ drift guard (birdybeep-agent-3d8.7).
 *
 * `examples/README.md` promises the committed per-harness configs are "not hand-written
 * approximations" but the byte-for-byte artifact each installer writes — and that CI catches
 * any drift. Nothing actually enforced that until now: the examples could silently rot the
 * moment a hook event, timeout, or key order changed, and an auditor reading them before
 * running the installer would be reading a lie.
 *
 * So: run the REAL `birdybeep agent install <harness>` into a hermetic temp HOME, then compare
 * the generated config to the committed example byte for byte. A deliberate generator change
 * fails here, and the fix is to copy the freshly generated file over the example (the same way
 * it was produced in the first place).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentAdapter } from "@birdybeep/agent-core";
import { claudeCodeAdapter, claudeSettingsPath } from "@birdybeep/claude-code";
import { codexAdapter, codexConfigFile } from "@birdybeep/codex";
import { cursorAdapter, cursorHooksPath } from "@birdybeep/cursor";
import { opencodeAdapter, opencodeConfigFile } from "@birdybeep/opencode";
import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./cli";
import { createAgentCommand } from "./commands/agent";
import { EXIT } from "./framework";

// packages/cli/src → repo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXAMPLES = join(REPO_ROOT, "examples");

/** Every harness with a committed example: its install target and where it writes. */
const HARNESSES: {
  target: string;
  adapter: AgentAdapter;
  example: string;
  generated: (home: string) => string;
}[] = [
  {
    target: "claude",
    adapter: claudeCodeAdapter,
    example: join(EXAMPLES, "claude-code", "settings.json"),
    generated: claudeSettingsPath,
  },
  {
    target: "codex",
    adapter: codexAdapter,
    example: join(EXAMPLES, "codex", "config.toml"),
    generated: (home) => codexConfigFile({ home }),
  },
  {
    target: "opencode",
    adapter: opencodeAdapter,
    example: join(EXAMPLES, "opencode", "opencode.json"),
    generated: (home) => opencodeConfigFile({ home }),
  },
  {
    target: "cursor",
    adapter: cursorAdapter,
    example: join(EXAMPLES, "cursor", "hooks.json"),
    generated: cursorHooksPath,
  },
];

let sandbox: Sandbox | undefined;
const ORIGINAL_CODEX_HOME = process.env["CODEX_HOME"];
beforeEach(() => delete process.env["CODEX_HOME"]); // the example is the ~/.codex default path
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});
afterAll(() => {
  if (ORIGINAL_CODEX_HOME !== undefined) process.env["CODEX_HOME"] = ORIGINAL_CODEX_HOME;
});

/** Force detection so the installer never skips a harness that isn't on this machine. */
function detected(adapter: AgentAdapter): AgentAdapter {
  return { ...adapter, detect: () => Promise.resolve({ detected: true, version: "test" }) };
}
function quiet(): {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
} {
  const sink = { write: () => undefined };
  return { stdout: sink, stderr: sink };
}

describe("examples/ match what the installers really write", () => {
  for (const harness of HARNESSES) {
    it(`${harness.target}: the committed example is byte-for-byte the generated config`, async () => {
      sandbox = createSandbox();
      const code = await runCli(["agent", "install", harness.target], {
        commands: [createAgentCommand({ adapters: [detected(harness.adapter)] })],
        ...quiet(),
        ensureConfig: false,
      });
      expect(code).toBe(EXIT.OK);

      const generated = readFileSync(harness.generated(sandbox.home), "utf8");
      const committed = readFileSync(harness.example, "utf8");
      expect(generated).toBe(committed);
      // The invariant every example advertises: never a token, never a secret.
      expect(committed).not.toMatch(/bbm_|mt_[0-9a-f]{8}|bearer /i);
    });
  }
});
