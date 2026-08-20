/**
 * Regression test for birdybeep-agent-lz9 — the bug the rest of the suite CANNOT see.
 *
 * `security` reads a passphrase with readpassphrase(3), which opens /dev/tty when a controlling
 * terminal exists and ignores the stdin pipe. Pairing therefore worked in every automated run
 * (CI, vitest and cloud sessions are all TTY-less) and failed for every human, who by definition
 * pairs from a real terminal: they got `security`'s own "password data for new item:" prompt,
 * whatever they typed became the item, and the read-back guard reported a mis-store.
 *
 * The macOS unit suite cannot catch this: it injects a fake runner whose stdin semantics ENCODE
 * the false premise. So this test allocates a real pty with script(1) and asserts the invariant
 * that actually fixes the bug — a child spawned with SECURITY_SPAWN_OPTIONS has no controlling
 * terminal, so it can never grab the tty out from under us.
 *
 * It deliberately does NOT touch the real OS keychain: that store is per-USER, not per-HOME, so
 * an isolated HOME would not protect the developer's own machine token.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SECURITY_SPAWN_OPTIONS } from "./token-store";

/** script(1) is the only pty allocator we can rely on without a native dependency. */
const hasPty = process.platform === "darwin" && spawnSync("which", ["script"]).status === 0;

/**
 * Run `probe` under a real pty and return its stdout.
 *
 * The probe spawns a child with the given options and reports whether that child could open
 * /dev/tty — i.e. whether it still had a controlling terminal.
 */
function probeUnderPty(options: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-pty-"));
  try {
    const probe = join(dir, "probe.mjs");
    const result = join(dir, "result.txt");
    writeFileSync(
      probe,
      `import { spawn } from "node:child_process";
       import { writeFileSync } from "node:fs";
       // The child opens /dev/tty and reports the outcome. Under a controlling terminal this
       // succeeds, which is exactly how \`security\` bypasses our stdin pipe.
       const code = "try { require('node:fs').openSync('/dev/tty','r'); console.log('HAS_TTY'); }" +
                    " catch { console.log('NO_TTY'); }";
       const child = spawn(process.execPath, ["-e", code], ${options});
       let out = "";
       child.stdout.on("data", (d) => (out += d));
       child.once("close", () => writeFileSync(${JSON.stringify(result)}, out.trim()));
       child.stdin.end();
      `,
    );
    // script(1) gives the probe a controlling terminal; without it the assertion is vacuous.
    // Its own stdout must be a tty or a FILE — under vitest it is a pipe, which script rejects
    // outright, so the probe reports through a file and script's stdout is discarded.
    spawnSync("script", ["-q", "/dev/null", process.execPath, probe], {
      stdio: "ignore",
      timeout: 30_000,
    });
    return existsSync(result) ? readFileSync(result, "utf8") : "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!hasPty)("macOS keychain: security can never read the terminal (lz9)", () => {
  it("gives the spawned child NO controlling terminal, even under a real pty", () => {
    const out = probeUnderPty(JSON.stringify(SECURITY_SPAWN_OPTIONS));
    expect(out).toContain("NO_TTY");
    expect(out).not.toContain("HAS_TTY");
  });

  it("FAILS the same probe without `detached` — proving the pty harness is not vacuous", () => {
    // This is the pre-fix spawn shape. If this ever reports NO_TTY the harness has stopped
    // reproducing the bug and the test above is no longer evidence of anything.
    const out = probeUnderPty(JSON.stringify({ stdio: ["pipe", "pipe", "pipe"] }));
    expect(out).toContain("HAS_TTY");
  });
});
