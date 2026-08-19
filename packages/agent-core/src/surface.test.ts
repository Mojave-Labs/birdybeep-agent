/**
 * Surface probe proof (birdybeep-agent-gcgp.6): the version readers work off the FILESYSTEM
 * only — nothing is executed — and refuse to report a version they cannot actually see. The
 * layouts are the real ones observed on macOS, including the nvm `versions/node/` decoy that
 * made every npm-installed harness report its version as "node".
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import {
  childDirectories,
  desktopSurfacesSupported,
  engineVersionFromPath,
  versionFromAppBundle,
  versionFromNodePackage,
  versionFromVersionedPath,
} from "./surface";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

describe("versionFromVersionedPath", () => {
  it("reads the build out of an installer's versions/ layout", () => {
    expect(versionFromVersionedPath("/u/.local/share/claude/versions/2.1.227")).toBe("2.1.227");
    expect(
      versionFromVersionedPath(
        "/u/.local/share/cursor-agent/versions/2026.07.09-a3815c0/cursor-agent",
      ),
    ).toBe("2026.07.09-a3815c0");
  });

  it("ignores a versions/ directory that is not a harness's (nvm)", () => {
    // Without the digit-led, dotted guard this reported the harness version as "node".
    expect(versionFromVersionedPath("/u/.nvm/versions/node/v26.1.0/bin/codex")).toBeUndefined();
  });

  it("is undefined when nothing in the path is a version", () => {
    expect(versionFromVersionedPath("/usr/local/bin/claude")).toBeUndefined();
  });

  /**
   * Windows accepts BOTH separators and a path can mix them, so splitting on `path.sep` alone
   * produced one segment there and lost every version — green on macOS and Linux, red only on
   * the Windows leg of the matrix. POSIX is the opposite case: `\` is legal IN a filename, so
   * splitting on it there would corrupt a real directory name. Both are asserted on every OS.
   */
  it("reads a Windows path with either separator, and both mixed", () => {
    const win = "win32" as NodeJS.Platform;
    expect(versionFromVersionedPath("C:\\Users\\d\\claude\\versions\\2.1.227", win)).toBe(
      "2.1.227",
    );
    expect(versionFromVersionedPath("C:/Users/d/claude/versions/2.1.227", win)).toBe("2.1.227");
    expect(versionFromVersionedPath("C:\\Users\\d/claude/versions/2.1.227", win)).toBe("2.1.227");
  });

  it("treats a backslash as part of the NAME on POSIX, where it legally is one", () => {
    const posix = "linux" as NodeJS.Platform;
    // A directory genuinely called `versions\2.1.227` is not a `versions/` layout.
    expect(versionFromVersionedPath("/home/d/claude/versions\\2.1.227", posix)).toBeUndefined();
    expect(versionFromVersionedPath("/home/d/claude/versions/2.1.227", posix)).toBe("2.1.227");
  });
});

describe("versionFromNodePackage", () => {
  it("reads the owning package's version for an npm-installed CLI", () => {
    sandbox = createSandbox();
    const pkg = sandbox.path("lib", "node_modules", "@openai", "codex");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@openai/codex", version: "0.147.0" }),
    );
    writeFileSync(join(pkg, "bin", "codex.js"), "#!/usr/bin/env node\n");
    expect(versionFromNodePackage(join(pkg, "bin", "codex.js"))).toBe("0.147.0");
  });

  it("refuses to read a package.json outside a node_modules tree", () => {
    sandbox = createSandbox();
    const dir = sandbox.path("opt", "thing", "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      sandbox.path("opt", "thing", "package.json"),
      JSON.stringify({ version: "9.9.9" }),
    );
    writeFileSync(join(dir, "codex"), "");
    expect(versionFromNodePackage(join(dir, "codex"))).toBeUndefined();
  });
});

describe("versionFromAppBundle", () => {
  it("reads a macOS app bundle's Electron payload manifest", () => {
    sandbox = createSandbox();
    const app = sandbox.path("Applications", "Cursor.app");
    mkdirSync(join(app, "Contents", "Resources", "app"), { recursive: true });
    writeFileSync(
      join(app, "Contents", "Resources", "app", "package.json"),
      JSON.stringify({ name: "Cursor", version: "3.15.6" }),
    );
    expect(versionFromAppBundle(app)).toBe("3.15.6");
  });

  it("is undefined for a bundle that keeps its version to itself", () => {
    sandbox = createSandbox();
    const app = sandbox.path("Applications", "ChatGPT.app");
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(app, "Contents", "Resources", "codex"), "");
    expect(versionFromAppBundle(app)).toBeUndefined();
  });
});

describe("engineVersionFromPath", () => {
  // Windows needs a privilege for symlinks; the layout under test is a POSIX installer's.
  it.skipIf(process.platform === "win32")("follows the symlink an installer leaves on PATH", () => {
    sandbox = createSandbox();
    const versions = sandbox.path("share", "claude", "versions");
    mkdirSync(versions, { recursive: true });
    writeFileSync(join(versions, "2.1.227"), "");
    mkdirSync(sandbox.path("bin"), { recursive: true });
    symlinkSync(join(versions, "2.1.227"), sandbox.path("bin", "claude"));
    expect(engineVersionFromPath(sandbox.path("bin", "claude"))).toBe("2.1.227");
  });
});

describe("childDirectories", () => {
  it("lists build directories and tolerates an absent root", () => {
    sandbox = createSandbox();
    mkdirSync(sandbox.path("builds", "2.1.229"), { recursive: true });
    mkdirSync(sandbox.path("builds", "2.1.228"), { recursive: true });
    writeFileSync(sandbox.path("builds", "notes.txt"), "");
    expect(childDirectories(sandbox.path("builds")).sort()).toEqual(["2.1.228", "2.1.229"]);
    expect(childDirectories(sandbox.path("nope"))).toEqual([]);
  });
});

describe("desktopSurfacesSupported", () => {
  it("is macOS-only — the other platforms' layouts are unobserved, so nothing is guessed", () => {
    expect(desktopSurfacesSupported({ platform: "darwin" })).toBe(true);
    expect(desktopSurfacesSupported({ platform: "linux" })).toBe(false);
    expect(desktopSurfacesSupported({ platform: "win32" })).toBe(false);
  });
});
