import { describe, expect, it } from "vitest";

import { BUILT_AGAINST_AGENT_CORE, CLAUDE_CODE_HARNESS_ID, claudeCodeMeta } from "./index";

describe("@birdybeep/claude-code scaffold", () => {
  it("exposes the Claude Code harness id", () => {
    expect(CLAUDE_CODE_HARNESS_ID).toBe("claude_code");
    expect(claudeCodeMeta.harness).toBe("claude_code");
  });

  it("resolves the cross-package import from @birdybeep/agent-core", () => {
    expect(BUILT_AGAINST_AGENT_CORE).toBe("0.0.0");
  });
});
