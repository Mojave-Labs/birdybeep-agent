/**
 * birdybeep-agent-gcgp.7: the `harness_version` shape guard. Every adapter feeds it a value
 * that ultimately came from the environment, a hook payload, or a file on disk — so the guard
 * has to admit every real version form observed on a live machine while rejecting anything
 * that isn't a version at all.
 */
import { describe, expect, it } from "vitest";

import { HARNESS_VERSION_MAX_CHARS, sanitizeHarnessVersion } from "./harness-version";

describe("sanitizeHarnessVersion accepts real harness versions", () => {
  it.each([
    ["2.1.227", "Claude Code terminal CLI"],
    ["2.1.229", "Claude Code desktop-bundled engine"],
    ["0.135.0", "codex-cli via npm"],
    ["0.148.0-alpha.9", "codex-cli bundled in ChatGPT.app"],
    ["0.147.0-alpha.1.2", "codex-cli reported by Codex Desktop rollouts"],
    ["3.14.27", "Cursor desktop"],
    ["2026.07.09-a3815c0", "cursor-agent CLI"],
    ["1.0.78", "GitHub Copilot CLI"],
    ["1.18.1", "opencode"],
  ])("keeps %s (%s)", (version) => {
    expect(sanitizeHarnessVersion(version)).toBe(version);
  });

  it("trims surrounding whitespace a --version probe or env export may carry", () => {
    expect(sanitizeHarnessVersion(" 1.2.3\n")).toBe("1.2.3");
  });
});

describe("sanitizeHarnessVersion rejects everything that is not a version", () => {
  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["1.2.3 (build 9)", "internal whitespace"],
    ["/Users/alice/.local/bin/claude", "an absolute path"],
    ["claude-code_2-1-229_harness", "an undecoded AI_AGENT value (underscore-led segments)"],
    [".2.1.229", "does not start alphanumeric"],
    ['1.2.3"; rm -rf /', "shell/quote injection"],
    ["1.2.3\u0000", "a NUL byte"],
    ["1.2.3\nX-Injected: yes", "a newline-embedded header"],
  ])("drops %s (%s)", (value) => {
    expect(sanitizeHarnessVersion(value)).toBeUndefined();
  });

  it("drops non-strings", () => {
    for (const value of [undefined, null, 1.23, {}, [], true]) {
      expect(sanitizeHarnessVersion(value)).toBeUndefined();
    }
  });

  it("drops an over-long value at the product integrations schema's max(64)", () => {
    const atCap = "1".repeat(HARNESS_VERSION_MAX_CHARS);
    expect(sanitizeHarnessVersion(atCap)).toBe(atCap);
    expect(sanitizeHarnessVersion("1".repeat(HARNESS_VERSION_MAX_CHARS + 1))).toBeUndefined();
  });
});
