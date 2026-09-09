import type { Writer } from "./framework";
import { BIRD, presentation } from "./presentation";

export interface BirdAnimation {
  wait(): () => void;
  celebrate(): Promise<void>;
}

export type BirdPose = "rest" | "inhale" | "breathe" | "crouch" | "stretch" | "flight" | "land";

/** Poses deform the body independently of its position; feet stay planted at rest. */
export function birdFrame(blink = false, lift = 0, pose: BirdPose = "rest"): string {
  const rows = BIRD.split("\n");
  if (pose === "inhale" || pose === "breathe") {
    rows[8] = pose === "inhale" ? "   ▀████████████████▀" : "  ▀▀████████████████▀▀";
  } else if (pose === "crouch" || pose === "land") {
    rows.splice(7, 1);
    rows.unshift("");
    rows[7] = "  ████████████████████";
    rows[8] = "    ████████████████";
    rows[9] = "      ██      ██";
  } else if (pose === "stretch") {
    rows[4] = "      ████████████████";
    rows[5] = "  ████████████████████";
    rows[6] = "    ████████████████";
    rows[7] = "    ████████████████";
    rows[9] = "      ██      ██";
    rows[10] = "      ▀▀      ▀▀";
  } else if (pose === "flight") {
    rows[4] = "██    ████████████████";
    rows[5] = "██████████╲███████████";
    rows[6] = "  █████████╲██████████";
    rows[7] = "    ████████████████";
    rows[9] = "        ▀▀  ▀▀";
    rows[10] = "";
  }
  if (blink)
    rows[pose === "crouch" || pose === "land" ? 4 : 3] = rows[
      pose === "crouch" || pose === "land" ? 4 : 3
    ]!.replace(" ▪  ", " ━  ");
  return [...Array<string>(2 - lift).fill(""), ...rows, ...Array<string>(lift).fill("")].join("\n");
}

export const HOP: readonly { pose: BirdPose; lift: number; ms: number }[] = [
  { pose: "crouch", lift: 0, ms: 180 },
  { pose: "stretch", lift: 1, ms: 80 },
  { pose: "flight", lift: 2, ms: 130 },
  { pose: "flight", lift: 2, ms: 110 },
  { pose: "stretch", lift: 1, ms: 90 },
  { pose: "land", lift: 0, ms: 140 },
  { pose: "inhale", lift: 0, ms: 120 },
  { pose: "rest", lift: 0, ms: 180 },
];

export function createBirdAnimation(
  output: Writer & { columns?: number; rows?: number },
  env: NodeJS.ProcessEnv = process.env,
): BirdAnimation {
  const allowed = () =>
    output.isTTY === true &&
    env.TERM !== "dumb" &&
    !env.CI &&
    env.BIRDYBEEP_ANIMATION !== "0" &&
    (output.columns ?? 80) >= 26 &&
    (output.rows ?? 40) >= 16;
  const style = presentation(output, env);
  let activeStop: (() => void) | undefined;
  const begin = () => {
    activeStop?.();
    if (!allowed()) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const paint = (frame: string, rewind = false) => {
      output.write(
        (rewind ? "\u001b[13A" : "") +
          frame
            .split("\n")
            .map((line) => `\r\u001b[2K${style.lime(line)}\n`)
            .join(""),
      );
    };
    const finish = (clear: boolean) => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      process.off("exit", stop);
      process.stdout.off("resize", resize);
      if (clear) output.write("\u001b[13A" + "\r\u001b[2K\n".repeat(13) + "\u001b[13A\r");
      activeStop = undefined;
    };
    const stop = () => finish(true);
    // A resized terminal may have reflowed the canvas; do not rewind through older output.
    const resize = () => {
      stopped = true;
      if (timer) clearInterval(timer);
      process.off("exit", stop);
      process.stdout.off("resize", resize);
      activeStop = undefined;
    };
    process.once("exit", stop);
    process.stdout.once("resize", resize);
    activeStop = stop;
    paint(birdFrame());
    return {
      stop,
      settle: () => finish(false),
      draw: (frame: string) => {
        if (!stopped) {
          paint(frame, true);
        }
      },
      repeat: (callback: () => void) => {
        timer = setInterval(callback, 140);
        timer.unref();
      },
    };
  };
  return {
    wait: () => {
      const canvas = begin();
      if (!canvas) return () => {};
      let tick = 0;
      canvas.repeat(() => {
        tick += 1;
        const phase = tick % 22;
        const pose =
          phase >= 8 && phase <= 10 ? "breathe" : phase >= 6 && phase <= 12 ? "inhale" : "rest";
        canvas.draw(birdFrame(phase === 18, 0, pose));
      });
      return canvas.stop;
    },
    celebrate: async () => {
      const canvas = begin();
      if (!canvas) return;
      try {
        for (const { pose, lift, ms } of HOP) {
          canvas.draw(birdFrame(pose === "land", lift, pose));
          await new Promise<void>((resolve) => setTimeout(resolve, ms));
        }
      } finally {
        canvas.settle();
      }
    },
  };
}
