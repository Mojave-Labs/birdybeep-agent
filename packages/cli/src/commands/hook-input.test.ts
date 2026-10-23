import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, it, vi } from "vitest";

import { runCli } from "../cli";
import {
  createHookCommand,
  detachCodexNotifyWorker,
  MAX_HOOK_INPUT_BYTES,
  NOTIFY_STDIN_FILE_ENV,
  readBoundedHookStdin,
  readHookPayload,
} from "./hook";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("counts multibyte bytes and accepts an exact-boundary payload", async () => {
  const stream = new PassThrough();
  const input = "é".repeat(MAX_HOOK_INPUT_BYTES / 2);
  const read = readBoundedHookStdin(stream);
  const bytes = Buffer.from(input);
  stream.write(bytes.subarray(0, 1)); // split a UTF-8 codepoint between chunks
  stream.end(bytes.subarray(1));
  expect(await read).toBe(input);
});

it("rejects overflow before accumulating it and removes stream listeners", async () => {
  const stream = new PassThrough();
  const read = readBoundedHookStdin(stream);
  const rejected = expect(read).rejects.toThrow();
  stream.write("é".repeat(MAX_HOOK_INPUT_BYTES / 2 + 1));
  await rejected;
  expect(stream.destroyed).toBe(true);
  for (const name of ["data", "end", "error", "close"]) expect(stream.listenerCount(name)).toBe(0);
});

it("bounds argv and injected stdin before parsing or launching a detached worker", async () => {
  const raw = "é".repeat(MAX_HOOK_INPUT_BYTES / 2 + 1);
  await expect(readHookPayload(["codex", raw], () => Promise.resolve(""))).rejects.toThrow();
  await expect(readHookPayload(["claude"], () => Promise.resolve(raw))).rejects.toThrow();
  expect(detachCodexNotifyWorker(raw)).toBe(false);
  const detach = vi.fn(() => true);
  const parse = vi.spyOn(JSON, "parse");
  const result = await fire(["codex", raw], { detachCodexNotify: detach });
  expect(result.code).toBe(1);
  expect(result.out).toContain("oversize-payload");
  expect(detach).not.toHaveBeenCalled();
  expect(parse.mock.calls.some(([value]) => value === raw)).toBe(false);
});

async function fire(args: string[], deps: Parameters<typeof createHookCommand>[0]) {
  let out = "";
  let err = "";
  const code = await runCli(["hook", ...args, "--json"], {
    commands: [createHookCommand(deps)],
    ensureConfig: false,
    stdout: {
      write: (s) => {
        out += s;
      },
    },
    stderr: {
      write: (s) => {
        err += s;
      },
    },
  });
  return { code, out, err };
}

it("timeout stops a never-ending stream and deletes detached-worker input", async () => {
  const stream = new PassThrough();
  const file = join(tmpdir(), `birdybeep-notify-${Date.now()}-test.json`);
  writeFileSync(file, "synthetic fixture");
  vi.stubEnv(NOTIFY_STDIN_FILE_ENV, file);
  const clear = vi.spyOn(globalThis, "clearTimeout");
  try {
    const result = await fire(["codex"], {
      readStdin: (signal) => readBoundedHookStdin(stream, signal),
      stdinTimeoutMs: 20,
    });
    expect(result.out).toContain("stdin-timeout");
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount("data")).toBe(0);
    expect(clear).toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  } finally {
    rmSync(file, { force: true });
  }
});

it("worker-file overflow is cleaned up and returns promptly", async () => {
  const stream = new PassThrough();
  const file = join(tmpdir(), `birdybeep-notify-${Date.now()}-overflow.json`);
  writeFileSync(file, "synthetic fixture");
  vi.stubEnv(NOTIFY_STDIN_FILE_ENV, file);
  try {
    const pending = fire(["codex"], {
      readStdin: (signal) => readBoundedHookStdin(stream, signal),
    });
    stream.end(Buffer.alloc(MAX_HOOK_INPUT_BYTES + 1));
    expect((await pending).out).toContain("oversize-payload");
    expect(existsSync(file)).toBe(false);
    expect(stream.destroyed).toBe(true);
  } finally {
    rmSync(file, { force: true });
  }
});

it("accepts legitimate harness JSON larger than the outbound event cap", async () => {
  const raw = JSON.stringify({
    hook_event_name: "PermissionRequest",
    session_id: "synthetic",
    cwd: "/tmp/project",
    tool_name: "Bash",
    tool_input: { command: "echo " + "x".repeat(200_000) },
  });
  const stream = new PassThrough();
  const read = readHookPayload(["claude"], () => readBoundedHookStdin(stream));
  stream.end(raw);
  expect(JSON.parse(await read)).toEqual(JSON.parse(raw));
});
