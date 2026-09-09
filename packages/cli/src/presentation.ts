import type { Writer } from "./framework";

// Pixel rows from the BirdyBeep mark; two columns per pixel preserve its proportions.
export const BIRD = [
  "          ████████",
  "        ████████████",
  "        ████▔▔▔▔████████",
  "      ██████ ▪  ██████",
  "██    ████████████████",
  "██████████████████████",
  "  ████████████████████",
  "  ████████████████████",
  "    ████████████████",
  "      ██      ██",
  "      ████    ████",
].join("\n");

export function presentation(
  output: Writer & { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
) {
  const terminal = output.isTTY === true && env.TERM !== "dumb";
  const color = terminal && !env.NO_COLOR;
  const lime = (text: string) => {
    if (!color) return text;
    const code = /^(truecolor|24bit)$/.test(env.COLORTERM ?? "")
      ? "38;2;198;242;78"
      : (env.TERM ?? "").includes("256color")
        ? "38;5;191"
        : "92";
    return `\u001b[${code}m${text}\u001b[0m`;
  };
  return {
    lime,
    banner: () => (terminal ? `\n${lime(BIRD)}\n\n` : ""),
    help: (text: string) =>
      text
        .split("\n")
        .map((line, i) => (i === 0 || line.endsWith(":") ? lime(line) : line))
        .join("\n"),
  };
}
