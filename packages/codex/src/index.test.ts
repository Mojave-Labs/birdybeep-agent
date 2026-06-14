import { describe, expect, it } from "vitest";

import { CODEX_HARNESS_ID, codexMeta } from "./index";

describe("@birdybeep/codex scaffold", () => {
  it("exposes the Codex harness id", () => {
    expect(CODEX_HARNESS_ID).toBe("codex");
    expect(codexMeta.harness).toBe("codex");
  });
});
