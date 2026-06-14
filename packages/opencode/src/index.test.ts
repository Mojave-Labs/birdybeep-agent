import { describe, expect, it } from "vitest";

import { OPENCODE_HARNESS_ID, opencodeMeta } from "./index";

describe("@birdybeep/opencode scaffold", () => {
  it("exposes the OpenCode harness id", () => {
    expect(OPENCODE_HARNESS_ID).toBe("opencode");
    expect(opencodeMeta.harness).toBe("opencode");
  });
});
