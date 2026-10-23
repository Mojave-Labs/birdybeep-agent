import { spawn as realSpawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

// Substitute only the trusted system binary with a synthetic child: never touch a user keychain.
const calls = vi.hoisted(() => [] as { program: string; args: readonly string[] }[]);
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (program: string, args: string[], options: object) => {
      calls.push({ program, args });
      if (program !== "/usr/bin/security") return actual.spawn(program, args, options);
      return actual.spawn(
        process.execPath,
        [
          "-e",
          `
      process.stdin.resume();
      process.stdin.on('end', () => process.stdout.write('synthetic-test-token\\n'));
    `,
        ],
        options,
      );
    },
  };
});

import { macosKeychainBackend } from "./token-store";

it.skipIf(process.platform === "win32")(
  "get/set/delete ignore a planted security on PATH",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-security-path-"));
    const marker = join(dir, "EXECUTED");
    const helper = join(dir, "security");
    const previous = process.env["PATH"];
    try {
      writeFileSync(helper, `#!/bin/sh\n: > '${marker}'\n`);
      chmodSync(helper, 0o755);
      process.env["PATH"] = dir;
      // Prove the helper is executable (control), then remove its marker.
      await new Promise<void>((resolve) => {
        realSpawn(helper).once("close", () => resolve());
      });
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      calls.length = 0;
      const backend = macosKeychainBackend();
      expect(await backend.get("test-service", "test-account")).toBe("synthetic-test-token");
      await backend.set("test-service", "test-account", "synthetic-test-token");
      await backend.delete("test-service", "test-account");
      expect(calls.map((call) => call.args[0])).toEqual([
        "find-generic-password",
        "add-generic-password",
        "find-generic-password",
        "delete-generic-password",
      ]);
      expect(calls.every((call) => call.program === "/usr/bin/security")).toBe(true);
      expect(calls.every((call) => !call.args.includes("synthetic-test-token"))).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
