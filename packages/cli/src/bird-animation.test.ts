import { afterEach, describe, expect, it, vi } from "vitest";

import { birdFrame, createBirdAnimation, HOP } from "./bird-animation";

afterEach(() => vi.useRealTimers());

describe("bird animation", () => {
  it("blinks while waiting and cancels its timer on stop", () => {
    vi.useFakeTimers();
    let text = "";
    const animation = createBirdAnimation(
      {
        isTTY: true,
        write: (s) => {
          text += s;
        },
      },
      {},
    );
    const stop = animation.wait();
    vi.advanceTimersByTime(2520);
    expect(text).toContain(" ━  ");
    stop();
    const settled = text;
    vi.advanceTimersByTime(5000);
    expect(text).toBe(settled);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps every hop frame the same height and finishes cleanly", async () => {
    vi.useFakeTimers();
    for (const lift of [0, 1, 2]) expect(birdFrame(false, lift).split("\n")).toHaveLength(13);
    const done = createBirdAnimation({ isTTY: true, write() {} }, {}).celebrate();
    await vi.runAllTimersAsync();
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("deforms the sprite through takeoff and landing, then leaves the resting bird visible", async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    for (const { pose, lift } of HOP) {
      const frame = birdFrame(false, lift, pose);
      expect(frame.split("\n")).toHaveLength(13);
      expect(Math.max(...frame.split("\n").map((row) => row.length))).toBeLessThan(26);
      if (pose !== "rest") expect(frame.trim()).not.toBe(birdFrame().trim());
    }
    const done = createBirdAnimation({ isTTY: true, write }, {}).celebrate();
    await vi.runAllTimersAsync();
    await done;
    expect(write.mock.calls.at(-1)?.[0]).toContain("      ████    ████");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps breathing and compression inside the chest silhouette", () => {
    const chestWidth = birdFrame().split("\n")[6]!.length;
    for (const pose of ["inhale", "breathe", "crouch", "land"] as const) {
      const rows = birdFrame(false, 0, pose).split("\n");
      for (const row of rows.slice(7, 11)) expect(row.length).toBeLessThanOrEqual(chestWidth);
      expect(rows.slice(-2)).toEqual(birdFrame().split("\n").slice(-2));
    }
  });
  it.each([{ TERM: "dumb" }, { CI: "1" }, { BIRDYBEEP_ANIMATION: "0" }])(
    "supports static environments %j",
    async (env) => {
      const write = vi.fn();
      const animation = createBirdAnimation({ isTTY: true, write }, env);
      animation.wait()();
      await animation.celebrate();
      expect(write).not.toHaveBeenCalled();
    },
  );
  it("stops on resize without rewinding reflowed output", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const stop = createBirdAnimation({ isTTY: true, write }, {}).wait();
    write.mockClear();
    process.stdout.emit("resize");
    vi.advanceTimersByTime(5000);
    stop();
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not animate pipes or narrow terminals", async () => {
    for (const output of [{ isTTY: false }, { isTTY: true, columns: 20 }]) {
      const write = vi.fn();
      const animation = createBirdAnimation({ ...output, write }, {});
      animation.wait()();
      await animation.celebrate();
      expect(write).not.toHaveBeenCalled();
    }
  });
});
