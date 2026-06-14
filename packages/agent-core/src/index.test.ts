import { describe, expect, it } from "vitest";

import { type AdapterMeta, AGENT_CORE_VERSION } from "./index";

describe("@birdybeep/agent-core scaffold", () => {
  it("exposes a version marker", () => {
    expect(AGENT_CORE_VERSION).toBe("0.0.0");
  });

  it("describes an adapter via the AdapterMeta shape", () => {
    const meta: AdapterMeta = { harness: "claude_code" };
    expect(meta.harness).toBe("claude_code");
  });
});
