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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentAdapter } from "@birdybeep/agent-core";
import {
  BIRDYBEEP_HOOK_EVENTS as CLAUDE_HOOK_EVENTS,
  claudeCodeAdapter,
  claudeSettingsPath,
} from "@birdybeep/claude-code";
import { codexAdapter, codexConfigFile } from "@birdybeep/codex";
import { COPILOT_HOOK_EVENTS, copilotAdapter, copilotHooksPath } from "@birdybeep/copilot";
import {
  BIRDYBEEP_HOOK_EVENTS as CURSOR_HOOK_EVENTS,
  cursorAdapter,
  cursorHooksPath,
} from "@birdybeep/cursor";
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
  /** Directory under examples/ — also used to prove no example dir is left unguarded. */
  dir: string;
  adapter: AgentAdapter;
  example: string;
  generated: (home: string) => string;
  /**
   * Hook event names the installer registers. The byte-diff below catches a changed CONFIG,
   * but not a README that still describes the old event set — so the prose is checked too.
   */
  events?: readonly string[];
}[] = [
  {
    target: "claude",
    dir: "claude-code",
    adapter: claudeCodeAdapter,
    example: join(EXAMPLES, "claude-code", "settings.json"),
    generated: claudeSettingsPath,
    events: CLAUDE_HOOK_EVENTS,
  },
  {
    target: "codex",
    dir: "codex",
    adapter: codexAdapter,
    example: join(EXAMPLES, "codex", "config.toml"),
    generated: (home) => codexConfigFile({ home }),
  },
  {
    target: "opencode",
    dir: "opencode",
    adapter: opencodeAdapter,
    example: join(EXAMPLES, "opencode", "opencode.json"),
    generated: (home) => opencodeConfigFile({ home }),
  },
  {
    target: "cursor",
    dir: "cursor",
    adapter: cursorAdapter,
    example: join(EXAMPLES, "cursor", "hooks.json"),
    generated: cursorHooksPath,
    events: CURSOR_HOOK_EVENTS,
  },
  {
    target: "copilot",
    dir: "copilot",
    adapter: copilotAdapter,
    example: join(EXAMPLES, "copilot", "birdybeep.json"),
    generated: (home) => copilotHooksPath({ home, env: {} }),
    events: COPILOT_HOOK_EVENTS,
  },
];

let sandbox: Sandbox | undefined;
const ORIGINAL_CODEX_HOME = process.env["CODEX_HOME"];
const ORIGINAL_COPILOT_HOME = process.env["COPILOT_HOME"];
beforeEach(() => {
  delete process.env["CODEX_HOME"];
  delete process.env["COPILOT_HOME"];
});
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});
afterAll(() => {
  if (ORIGINAL_CODEX_HOME !== undefined) process.env["CODEX_HOME"] = ORIGINAL_CODEX_HOME;
  if (ORIGINAL_COPILOT_HOME !== undefined) process.env["COPILOT_HOME"] = ORIGINAL_COPILOT_HOME;
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

  /**
   * The byte-diff above cannot see PROSE rot: `examples/claude-code/README.md` listed six hook
   * events for months after the installer started writing seven (`SessionEnd`, #20). A README
   * that under-describes the footprint is exactly the kind of thing an auditor relies on.
   */
  for (const harness of HARNESSES) {
    const events = harness.events;
    if (!events) continue;
    it(`${harness.target}: its example README names every event the installer registers`, () => {
      const readme = readFileSync(join(EXAMPLES, harness.dir, "README.md"), "utf8");
      for (const event of events) {
        expect(readme, `README omits the ${event} hook`).toContain(event);
      }
    });
  }

  /**
   * HARNESSES is hand-maintained, so a new examples/<harness>/ directory could land completely
   * unguarded — the failure mode this whole file exists to prevent. Every directory must be
   * claimed by a row above.
   */
  it("guards every directory under examples/", () => {
    const dirs = readdirSync(EXAMPLES).filter((entry) =>
      statSync(join(EXAMPLES, entry)).isDirectory(),
    );
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs.sort()).toEqual(HARNESSES.map((h) => h.dir).sort());
  });
});
