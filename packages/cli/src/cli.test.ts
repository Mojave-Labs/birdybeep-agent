import { describe, expect, it } from "vitest";

import { CLI_VERSION, renderHelp, run } from "./cli";

describe("@birdybeep/cli scaffold", () => {
  it("renders help text naming the binary and its commands", () => {
    const help = renderHelp();
    expect(help).toContain("birdybeep");
    expect(help).toContain("doctor");
  });

  it("exits 0 for --help and --version", () => {
    expect(run(["--help"])).toBe(0);
    expect(run(["--version"])).toBe(0);
    expect(run([])).toBe(0);
  });

  it("exits nonzero for a not-yet-implemented command", () => {
    expect(run(["login"])).toBe(1);
  });

  it("reports a stable version marker", () => {
    expect(CLI_VERSION).toBe("0.0.0");
  });
});
