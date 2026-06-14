/**
 * Node version guard proof: the major is parsed correctly and only sub-minimum versions
 * produce an error message (the CLI must fail gracefully on old Node, not crash).
 */
import { describe, expect, it } from "vitest";

import { MIN_NODE_MAJOR, nodeVersionError, parseNodeMajor } from "./node-check";

describe("node-check", () => {
  it("parses the Node major version", () => {
    expect(parseNodeMajor("20.11.0")).toBe(20);
    expect(parseNodeMajor("v18.18.2")).toBe(18);
    expect(parseNodeMajor("garbage")).toBeNull();
  });

  it("errors only below the minimum, with a clear upgrade message", () => {
    expect(nodeVersionError(`${MIN_NODE_MAJOR}.0.0`)).toBeNull();
    expect(nodeVersionError("22.0.0")).toBeNull();
    const err = nodeVersionError("18.18.0");
    expect(err).toMatch(new RegExp(`requires Node ${MIN_NODE_MAJOR}\\+`));
    expect(err).toContain("18.18.0");
  });

  it("does not block on an unparseable version (best-effort)", () => {
    expect(nodeVersionError("weird")).toBeNull();
  });
});
