/**
 * SECURITY proof (sec-review-2026-07 H1/M6): the Windows command-resolution hijack.
 *
 * A bare-name spawn lets the OS resolver search the CURRENT WORKING DIRECTORY before PATH on
 * Windows, so a hostile repo shipping `birdybeep.exe`/`.cmd`/`.bat` (or `codex.exe`, …) at its
 * root gets executed the moment an adapter spawns the CLI while the harness's cwd is that repo.
 *
 * Two layers of proof, BOTH run on every OS (never skipped — so CI's windows-latest job
 * exercises the real spawn):
 *  1. `resolveOnPath` unit tests with an INJECTED platform/env — these encode the Windows
 *     resolution rules (PATHEXT, cwd/relative-entry exclusion) and fail against any resolver
 *     that would take a cwd/`.`-relative hit.
 *  2. REAL spawn tests: plant a hostile `birdybeep` in the cwd and (in one case) a legit one on
 *     PATH, then run the actual `safeSpawn`/`safeExecFile` with cwd = the hostile dir and assert
 *     the planted binary is NEVER executed. On windows-latest these genuinely reproduce the OS
 *     cwd-first behavior; on POSIX they still exercise the real spawn end-to-end.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { needsShellToLaunch, resolveOnPath, safeExecFile, safeSpawn } from "./safe-spawn";

const IS_WINDOWS = process.platform === "win32";
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Plant a runnable "birdybeep" that writes `marker` on execution, in `dir`. Returns nothing. */
function plantBirdybeep(dir: string, marker: string): void {
  if (IS_WINDOWS) {
    // A .cmd shim writes the marker then drains stdin (so the parent's stdin.end() never EPIPEs).
    writeFileSync(
      join(dir, "birdybeep.cmd"),
      `@echo off\r\n> ${JSON.stringify(marker)} echo ran\r\nmore > nul 2>nul\r\n`,
    );
  } else {
    const p = join(dir, "birdybeep");
    writeFileSync(p, `#!/bin/sh\ncat > /dev/null 2>&1\n: > ${JSON.stringify(marker)}\n`);
    chmodSync(p, 0o755);
  }
}

/** Await a child's exit (resolve on 'exit' or 'error'), with a hard cap so a test can't hang. */
function awaitExit(child: import("node:child_process").ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => resolve();
    child.on("exit", done);
    child.on("error", done);
    setTimeout(done, 4000).unref?.();
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveOnPath — searches PATH only, never the cwd (the hijack fix)", () => {
  it("returns the absolute path of a binary that exists in an absolute PATH dir", () => {
    const binDir = makeTempDir("bb-bin-");
    const name = IS_WINDOWS ? "tool.cmd" : "tool";
    writeFileSync(join(binDir, name), "x");
    const resolved = resolveOnPath("tool", {
      platform: process.platform,
      env: { PATH: binDir, PATHEXT: ".CMD;.EXE" },
    });
    expect(resolved).toBe(join(binDir, name));
  });

  it("returns null when the name exists ONLY in the cwd and cwd is not an absolute PATH entry", () => {
    // The core property: a binary sitting in the working directory must be UNreachable.
    const repo = makeTempDir("bb-repo-");
    writeFileSync(join(repo, "birdybeep.cmd"), "@echo pwned");
    writeFileSync(join(repo, "birdybeep"), "#!/bin/sh\n");
    // PATH points somewhere else entirely; the repo (cwd) is not on it.
    const elsewhere = makeTempDir("bb-empty-");
    expect(
      resolveOnPath("birdybeep", { platform: "win32", env: { PATH: elsewhere, PATHEXT: ".CMD" } }),
    ).toBeNull();
    expect(resolveOnPath("birdybeep", { platform: "linux", env: { PATH: elsewhere } })).toBeNull();
  });

  it("REFUSES a relative PATH entry (`.` or a bare dir) — the only way PATH could point at cwd", () => {
    // Even if the attacker gets `.` onto PATH and plants the binary in cwd, a relative entry
    // resolves against cwd and must be skipped. A cwd-including resolver would take the bait.
    const repo = makeTempDir("bb-cwddot-");
    const winName = join(repo, "birdybeep.cmd");
    const posixName = join(repo, "birdybeep");
    writeFileSync(winName, "@echo pwned");
    writeFileSync(posixName, "#!/bin/sh\n");
    const prev = process.cwd();
    try {
      process.chdir(repo);
      // "." is a relative entry → skipped; only the (empty) absolute entry counts → not found.
      const emptyAbs = makeTempDir("bb-abs-");
      expect(
        resolveOnPath("birdybeep", {
          platform: "win32",
          env: { PATH: `.${";"}${emptyAbs}`, PATHEXT: ".CMD" },
        }),
      ).toBeNull();
      expect(
        resolveOnPath("birdybeep", { platform: "linux", env: { PATH: `.:${emptyAbs}` } }),
      ).toBeNull();
    } finally {
      process.chdir(prev);
    }
  });

  it("applies PATHEXT order on Windows and prefers an earlier extension", () => {
    const binDir = makeTempDir("bb-ext-");
    writeFileSync(join(binDir, "tool.cmd"), "x");
    writeFileSync(join(binDir, "tool.exe"), "x");
    const resolved = resolveOnPath("tool", {
      platform: "win32",
      env: { PATH: binDir, PATHEXT: ".EXE;.CMD" },
    });
    // Windows is case-insensitive; the resolved path carries PATHEXT's casing (`.EXE`).
    expect(resolved?.toLowerCase()).toBe(join(binDir, "tool.exe").toLowerCase());
  });

  it("reads Path when PATH is absent (Windows env casing)", () => {
    const binDir = makeTempDir("bb-casing-");
    writeFileSync(join(binDir, "tool.cmd"), "x");
    const resolved = resolveOnPath("tool", {
      platform: "win32",
      env: { Path: binDir, PATHEXT: ".CMD" },
    });
    expect(resolved?.toLowerCase()).toBe(join(binDir, "tool.cmd").toLowerCase());
  });

  it("flags .cmd/.bat as needing a shell, .exe / extensionless as not", () => {
    expect(needsShellToLaunch("C:\\bin\\birdybeep.cmd")).toBe(true);
    expect(needsShellToLaunch("C:\\bin\\birdybeep.BAT")).toBe(true);
    expect(needsShellToLaunch("C:\\bin\\birdybeep.exe")).toBe(false);
    expect(needsShellToLaunch("/usr/local/bin/birdybeep")).toBe(false);
  });
});

describe("safeSpawn — real OS spawn never executes a cwd-planted binary", () => {
  it("returns null (spawns NOTHING) when the command is only in the cwd, not on PATH", async () => {
    const repo = makeTempDir("bb-hostile-");
    const pwned = join(repo, "PWNED");
    plantBirdybeep(repo, pwned);
    const emptyPath = makeTempDir("bb-nopath-");
    const prev = process.cwd();
    try {
      process.chdir(repo); // the harness's cwd == the hostile repo (the attack setup)
      const child = safeSpawn("birdybeep", ["hook", "opencode"], {
        env: { ...process.env, PATH: emptyPath },
        stdio: ["ignore", "ignore", "ignore"],
      });
      expect(child).toBeNull(); // NOT found on PATH → no bare-name fallback, nothing runs
    } finally {
      process.chdir(prev);
    }
    // Give any (erroneously) spawned process a moment, then prove it never ran.
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(pwned)).toBe(false);
  });

  it("runs the PATH binary, NEVER the identically-named one planted in the cwd", async () => {
    const repo = makeTempDir("bb-hostile2-");
    const binDir = makeTempDir("bb-legit-");
    const pwned = join(repo, "PWNED");
    const good = join(binDir, "GOOD");
    plantBirdybeep(repo, pwned); // hostile, in cwd
    plantBirdybeep(binDir, good); // legit, on PATH
    const prev = process.cwd();
    let child: import("node:child_process").ChildProcess | null = null;
    try {
      process.chdir(repo);
      child = safeSpawn("birdybeep", ["hook", "opencode"], {
        env: { ...process.env, PATH: binDir },
        stdio: ["ignore", "ignore", "ignore"],
      });
      expect(child).not.toBeNull();
    } finally {
      process.chdir(prev);
    }
    if (child !== null) await awaitExit(child);
    expect(existsSync(good)).toBe(true); // the PATH binary ran (delivery works)
    expect(existsSync(pwned)).toBe(false); // the cwd binary did NOT (hijack closed)
  });
});

describe("safeExecFile — read-only probes never execute a cwd-planted binary", () => {
  it("returns null when the probed command is only in the cwd, not on PATH", async () => {
    const repo = makeTempDir("bb-probe-");
    const pwned = join(repo, "PWNED");
    plantBirdybeep(repo, pwned); // pretend this is `codex` planted in the repo
    const emptyPath = makeTempDir("bb-probe-empty-");
    const prev = process.cwd();
    try {
      process.chdir(repo);
      const result = await safeExecFile("birdybeep", ["--version"], {
        env: { ...process.env, PATH: emptyPath },
        timeout: 2000,
      });
      expect(result).toBeNull();
    } finally {
      process.chdir(prev);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(pwned)).toBe(false);
  });
});
