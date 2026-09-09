import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatch } from "./framework";
import { BIRD, presentation } from "./presentation";

describe("terminal presentation", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses the brand lime on truecolor terminals and falls back to ANSI green", () => {
    const output = { isTTY: true, write() {} };
    expect(presentation(output, { COLORTERM: "truecolor" }).banner()).toContain(
      "\u001b[38;2;198;242;78m",
    );
    expect(presentation(output, { TERM: "xterm" }).banner()).toContain("\u001b[92m");
    expect(presentation(output, { TERM: "xterm-256color" }).banner()).toContain("\u001b[38;5;191m");
  });

  it("respects NO_COLOR, redirected output, and dumb terminals", () => {
    expect(presentation({ isTTY: true, write() {} }, { NO_COLOR: "1" }).banner()).toBe(
      `\n${BIRD}\n\n`,
    );
    expect(presentation({ write() {} }, {}).banner()).toBe("");
    expect(presentation({ isTTY: true, write() {} }, { TERM: "dumb" }).banner()).toBe("");
  });

  it.each([
    [],
    ["--json"],
    ["--version"],
    ["setup"],
    ["pair"],
    ["hook"],
    ["setup", "--non-interactive"],
    ["pair", "--json"],
  ])("keeps command output isolated: %j", async (...args: string[]) => {
    vi.stubEnv("TERM", "xterm-256color");
    let text = "";
    await dispatch(args, {
      version: "1.0.0",
      commands: ["setup", "pair", "hook"].map((name) => ({
        name,
        summary: name,
        run: ({ io }) => {
          io.emit("ok", { ok: true });
          return 0;
        },
      })),
      stdout: {
        isTTY: true,
        write: (s) => {
          text += s;
        },
      },
      stderr: { write() {} },
      ensureConfig: false,
    });
    if (args.includes("--json"))
      expect(() => {
        JSON.parse(text);
      }).not.toThrow();
    else if (args.includes("--version")) expect(text).toBe("1.0.0\n");
    else if (args.includes("hook") || args.includes("--non-interactive")) expect(text).toBe("ok\n");
    else expect(text).toContain(BIRD);
  });
});
