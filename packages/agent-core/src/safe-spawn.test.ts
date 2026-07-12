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
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

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
    setTimeout(done, 12000).unref?.(); // generous: cmd.exe + node cold start on a loaded Windows runner
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    // maxRetries/retryDelay: a spawned child runs with cwd = its bin dir on Windows, which locks
    // the dir until the child exits — retry the rmdir past the transient EBUSY rather than fail.
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  }
});

describe("resolveOnPath — searches PATH only, never the cwd (the hijack fix)", () => {
  it("returns the absolute path of a binary that exists in an absolute PATH dir", () => {
    const binDir = makeTempDir("bb-bin-");
    const name = IS_WINDOWS ? "tool.cmd" : "tool";
    const p = join(binDir, name);
    writeFileSync(p, "x");
    if (!IS_WINDOWS) chmodSync(p, 0o755); // POSIX: resolver is now execvp-like (skips non-exec)
    // Lowercase PATHEXT so the resolver's `command + ext` matches the lowercase planted file on
    // BOTH case-insensitive (Windows/macOS) and case-sensitive (linux) filesystems — PATHEXT
    // casing is irrelevant on real Windows, but a case-sensitive host needs the cases to agree.
    const resolved = resolveOnPath("tool", {
      platform: process.platform,
      env: { PATH: binDir, PATHEXT: ".cmd;.exe" },
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
    // Lowercase PATHEXT (casing is irrelevant on real Windows) so `tool + .exe` matches the
    // lowercase planted file on a case-sensitive host too; `.exe` before `.cmd` proves the order.
    const resolved = resolveOnPath("tool", {
      platform: "win32",
      env: { PATH: binDir, PATHEXT: ".exe;.cmd" },
    });
    expect(resolved?.toLowerCase()).toBe(join(binDir, "tool.exe").toLowerCase());
  });

  it("prefers birdybeep.cmd over a co-located extensionless npm sh-wrapper on Windows (real npm layout)", () => {
    // REGRESSION GUARD (birdybeep-agent-llp/6pf/dr8 follow-up): a standard `npm i -g` co-locates
    // THREE files for `birdybeep` in ONE on-PATH directory — an extensionless `birdybeep` (a
    // `#!/bin/sh` shebang wrapper, for MSYS/Git-Bash), `birdybeep.cmd` (cmd.exe) and
    // `birdybeep.ps1` (PowerShell). Windows CreateProcess cannot launch the shebang wrapper, so
    // the resolver MUST pick the `.cmd`. Resolving the extensionless wrapper (the bug: extension
    // list led with "") makes needsShellToLaunch false → spawn-without-shell → OpenCode event
    // delivery breaks and version detection degrades to "unknown", on the exact platform the fix
    // targets. Injected win32 → this discriminates the fix on any host (incl. macOS CI).
    const binDir = makeTempDir("bb-npm-");
    writeFileSync(join(binDir, "birdybeep"), '#!/bin/sh\nexec node bb.js "$@"\n'); // sh wrapper
    writeFileSync(join(binDir, "birdybeep.cmd"), "@node bb.js %*\r\n"); // cmd.exe shim
    writeFileSync(join(binDir, "birdybeep.ps1"), "#!/usr/bin/env pwsh\n"); // powershell shim
    const resolved = resolveOnPath("birdybeep", {
      platform: "win32",
      env: { PATH: binDir, PATHEXT: ".com;.exe;.bat;.cmd" }, // lowercase → matches on case-sensitive fs too
    });
    expect(resolved?.toLowerCase()).toBe(join(binDir, "birdybeep.cmd").toLowerCase());
    expect(resolved).not.toBe(join(binDir, "birdybeep")); // NOT the extensionless sh wrapper
    expect(needsShellToLaunch(resolved as string)).toBe(true); // so safeSpawn uses the shell
  });

  it("picks the absolute PATH birdybeep, never a cwd-planted .cmd/.exe reached via a leading `.` (win32, host-observable)", () => {
    // The hijack itself, made observable ON THE HOST WE RUN ON: inject win32 + put a hostile
    // `birdybeep.cmd`/`.exe` in the (simulated) harness cwd and `.` FIRST on PATH — so a resolver
    // that honored cwd/relative entries would return the hostile one before ever reaching the
    // legit install dir. The correct resolver skips `.` and returns the absolute PATH entry. This
    // fails against a cwd-searching resolver on macOS (not only on windows-latest CI).
    const repo = makeTempDir("bb-hijack-"); // the harness cwd == the attacker's repo
    const legit = makeTempDir("bb-legit-"); // the real global install dir, on PATH
    writeFileSync(join(repo, "birdybeep.cmd"), "@echo pwned\r\n"); // hostile, in cwd
    writeFileSync(join(repo, "birdybeep.exe"), "MZ"); // hostile alt, in cwd
    writeFileSync(join(legit, "birdybeep.cmd"), "@node real.js %*\r\n"); // legit, on PATH
    const prev = process.cwd();
    try {
      process.chdir(repo);
      // `pathDirectories` splits on the HOST `delimiter`, so join with it (":" on macOS, ";" on
      // windows-latest) to get "." as a genuine, standalone leading entry on either CI host.
      const resolved = resolveOnPath("birdybeep", {
        platform: "win32",
        env: { PATH: `.${delimiter}${legit}`, PATHEXT: ".com;.exe;.bat;.cmd" }, // lowercase: case-sensitive-fs safe
      });
      expect(resolved?.toLowerCase()).toBe(join(legit, "birdybeep.cmd").toLowerCase());
      expect(resolved).not.toBe(join(repo, "birdybeep.cmd")); // hijack .cmd not chosen
      expect(resolved).not.toBe(join(repo, "birdybeep.exe")); // hijack .exe not chosen
    } finally {
      process.chdir(prev);
    }
  });

  it.skipIf(IS_WINDOWS)(
    "skips a non-executable file earlier on PATH and keeps searching (POSIX, execvp semantics)",
    () => {
      // execvp does NOT stop at the first name match — it skips a present-but-non-executable file
      // and continues down PATH. A bare existsSync would return the non-exec hit and the later
      // spawn would EACCES. (Assumes a non-root test user; root's access(X_OK) ignores mode bits.)
      const early = makeTempDir("bb-noexec-");
      const late = makeTempDir("bb-exec-");
      const nonExec = join(early, "tool");
      writeFileSync(nonExec, "just data, not runnable");
      chmodSync(nonExec, 0o644); // present but NOT executable → must be skipped
      const good = join(late, "tool");
      writeFileSync(good, "#!/bin/sh\n:\n");
      chmodSync(good, 0o755); // the real executable, later on PATH
      const resolved = resolveOnPath("tool", {
        platform: "linux",
        env: { PATH: `${early}${delimiter}${late}` },
      });
      expect(resolved).toBe(good);
    },
  );

  it("reads Path when PATH is absent (Windows env casing)", () => {
    const binDir = makeTempDir("bb-casing-");
    writeFileSync(join(binDir, "tool.cmd"), "x");
    const resolved = resolveOnPath("tool", {
      platform: "win32",
      env: { Path: binDir, PATHEXT: ".cmd" }, // lowercase → matches on case-sensitive fs too
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

/**
 * DELIVERY proof (birdybeep-agent-dr8 real-Windows follow-up): `safeSpawn({ input })` must get the
 * event payload to the launched CLI's STDIN on Windows too. Piping into a `.cmd` through cmd.exe
 * did NOT reach the batch shim's node grandchild (windows-latest CI: every event dropped), so the
 * payload is now delivered via a strict-perm temp file the child reads as stdin — an inherited fd
 * on POSIX, and a `< "file"` shell redirection for a Windows `.cmd`. Both are exercised HERE on the
 * host we run on: the win32 case injects `platform: "win32"`, which makes Node's `shell: true` use
 * the host shell (`/bin/sh` on macOS/linux), and `/bin/sh` honors `cmd < file` exactly like
 * `cmd.exe` — so the redirect-line construction is proven off-Windows, leaving only the shell's
 * redirect parser (identical semantics on both) to windows-latest.
 */
describe("safeSpawn — input delivers the payload to the child's stdin (Windows-safe temp-file path)", () => {
  /** Plant a `birdybeep`-like command that copies its STDIN into `marker` then exits (host-native). */
  function plantStdinEcho(dir: string, name: string, marker: string): void {
    const p = join(dir, name);
    if (IS_WINDOWS && name.toLowerCase().endsWith(".cmd")) {
      // A real Windows batch shim: node copies stdin (redirected from our temp file) to the marker.
      const js =
        "const fs=require('fs');let d='';" +
        "process.stdin.on('data',c=>d+=c);" +
        `process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(marker)},d));` +
        "process.stdin.resume();";
      writeFileSync(p, `@"${process.execPath}" -e "${js.replace(/"/g, '\\"')}"\r\n`);
    } else {
      // POSIX executable. Also used for the injected-win32-on-macOS `.cmd` case: `/bin/sh` execs
      // this via its shebang and feeds it the redirected stdin, mirroring cmd.exe running a batch.
      writeFileSync(p, `#!/bin/sh\ncat > ${JSON.stringify(marker)}\n`);
      chmodSync(p, 0o755);
    }
  }

  function lingeringDeliveryTempFiles(): string[] {
    return readdirSync(tmpdir()).filter((f) => f.startsWith("birdybeep-hook-"));
  }

  it.skipIf(IS_WINDOWS)(
    "delivers input to a POSIX binary by piping straight to stdin",
    async () => {
      const binDir = makeTempDir("bb-in-posix-");
      const marker = join(binDir, "GOT.json");
      plantStdinEcho(binDir, "birdybeep", marker);
      const payload = JSON.stringify({ type: "session.created", n: 1 });
      const before = lingeringDeliveryTempFiles().length;

      const child = safeSpawn("birdybeep", ["hook", "opencode"], {
        env: { PATH: binDir },
        platform: "linux",
        input: payload,
      });
      expect(child).not.toBeNull();
      if (child !== null) await awaitExit(child);
      await new Promise((r) => setTimeout(r, 100));

      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe(payload); // the exact bytes reached stdin
      expect(lingeringDeliveryTempFiles().length).toBe(before); // POSIX uses no temp file (none leaked)
    },
  );

  it("delivers input to a Windows .cmd shim via `< file` shell redirection, even with detached requested (injected win32)", async () => {
    // On macOS/linux this drives Node's shell:true through /bin/sh, which honors `"cmd" < "file"`
    // just like cmd.exe. It mirrors the real plugin path: the npm layout co-locates an
    // extensionless `birdybeep` (a `#!/bin/sh` wrapper) with `birdybeep.cmd` — the resolver must
    // still pick the `.cmd` — and the caller requests `detached: true`. On windows-latest a
    // DETACHED shell spawn drops the redirect, so safeSpawn must NOT detach the `.cmd` branch;
    // this asserts delivery still happens with detached requested (the fix), on the host we run on.
    const binDir = makeTempDir("bb-in-cmd-");
    const marker = join(binDir, "GOT.json");
    writeFileSync(join(binDir, "birdybeep"), "#!/bin/sh\nexit 0\n"); // co-located extensionless wrapper
    plantStdinEcho(binDir, "birdybeep.cmd", marker);
    const payload = JSON.stringify({ type: "session.created", via: "redirect" });

    const child = safeSpawn("birdybeep", ["hook", "opencode"], {
      env: { PATH: binDir, PATHEXT: ".com;.exe;.bat;.cmd" }, // lowercase → matches on case-sensitive fs too
      platform: "win32",
      input: payload,
      detached: true, // requested by the caller; the .cmd redirect branch ignores it (delivery must still work)
    });
    expect(child).not.toBeNull();
    if (child !== null) await awaitExit(child);
    await new Promise((r) => setTimeout(r, 100));

    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8").trim()).toBe(payload); // the payload arrived on stdin
  });

  it("writes NO delivery temp file (and spawns nothing) when the command is not on PATH", async () => {
    const emptyPath = makeTempDir("bb-in-nopath-");
    const before = lingeringDeliveryTempFiles().length;
    const child = safeSpawn("birdybeep", ["hook", "opencode"], {
      env: { PATH: emptyPath },
      platform: "linux",
      input: JSON.stringify({ type: "session.created" }),
    });
    expect(child).toBeNull(); // resolve fails first → no temp file is ever created
    await new Promise((r) => setTimeout(r, 50));
    expect(lingeringDeliveryTempFiles().length).toBe(before);
  });
});
