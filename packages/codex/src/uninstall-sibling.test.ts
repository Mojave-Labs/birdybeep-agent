/**
 * birdybeep-agent-gcgp.19 REGRESSION — uninstall must not delete a user's sibling command.
 *
 * The bug: `isBirdyBeepHookEntry()` is a `.some()` over the MATCHER ENTRY's nested hooks array,
 * and uninstall filtered whole entries with it — so a Codex user who added their own command to
 * the same `[[hooks.X]]` entry as BirdyBeep's lost it on `birdybeep agent uninstall codex`. That
 * is silent data loss in a user's own config, and a violation of the stated uninstall contract
 * ("removes only BirdyBeep-managed entries"). Identical in shape to the Claude Code bug gcgp.9
 * fixed; this ports that fix and pins it.
 *
 * Every case below is written against the CONFIG THE INSTALLER ACTUALLY WROTE, then re-read from
 * disk after a real uninstall — no hand-built structures standing in for the real thing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createSandbox, type Sandbox } from "@birdybeep/test-harness";
import { parse } from "smol-toml";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { installCodex, isBirdyBeepHook, isBirdyBeepHookEntry } from "./install";
import { codexConfigFile } from "./paths";
import { uninstallCodex } from "./uninstall";

let sandbox: Sandbox | undefined;
const ORIGINAL = process.env["CODEX_HOME"];
beforeEach(() => delete process.env["CODEX_HOME"]);
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});
afterAll(() => {
  if (ORIGINAL !== undefined) process.env["CODEX_HOME"] = ORIGINAL;
});

const USER_COMMAND = "my-own-codex-hook --report";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readConfig(home: string): Record<string, unknown> {
  return asRecord(parse(readFileSync(codexConfigFile({ home }), "utf8")));
}

function entriesFor(config: Record<string, unknown>, event: string): unknown[] {
  const entries = asRecord(config["hooks"])[event];
  return Array.isArray(entries) ? entries : [];
}

/** Commands inside one matcher entry, in order. */
function commandsIn(entry: unknown): unknown[] {
  const hooks = asRecord(entry)["hooks"];
  return Array.isArray(hooks) ? hooks.map((h) => asRecord(h)["command"]) : [];
}

/**
 * Install, then move the user's own command INTO BirdyBeep's matcher entry — the exact shape a
 * user produces by editing `config.toml` to group their hook with ours under one matcher.
 */
async function installThenShareEntry(sb: Sandbox, event = "Stop"): Promise<void> {
  await installCodex({ dataDir: sb.path("data") }, sb.home);
  const config = readConfig(sb.home);
  const entries = entriesFor(config, event);
  const ours = entries.findIndex(isBirdyBeepHookEntry);
  expect(ours).toBeGreaterThanOrEqual(0);
  const entry = asRecord(entries[ours]);
  const hooks = [...(entry["hooks"] as unknown[])];
  hooks.push({ type: "command", command: USER_COMMAND, timeout: 42 });
  // A field BirdyBeep knows nothing about, on the shared entry: it must survive too.
  entries[ours] = { ...entry, hooks, matcher: "Bash", failClosed: true };
  const hooksBlock = asRecord(config["hooks"]);
  hooksBlock[event] = entries;
  const path = codexConfigFile({ home: sb.home });
  mkdirSync(dirname(path), { recursive: true });
  const { stringify } = await import("smol-toml");
  writeFileSync(path, `${stringify({ ...config, hooks: hooksBlock })}\n`);
}

describe("gcgp.19: uninstall removes ONLY BirdyBeep's command from a shared matcher entry", () => {
  it("keeps the user's sibling command, its matcher, and unknown fields", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    await installThenShareEntry(sb);

    await uninstallCodex({ dataDir: sb.path("data") }, sb.home);

    const after = readConfig(sb.home);
    const entries = entriesFor(after, "Stop");
    // The entry SURVIVES — this is the whole bug: it used to be dropped wholesale.
    expect(entries).toHaveLength(1);
    const entry = asRecord(entries[0]);
    expect(commandsIn(entry)).toEqual([USER_COMMAND]); // ours gone, theirs kept
    expect(entry["matcher"]).toBe("Bash"); // not reset by a rebuild
    expect(entry["failClosed"]).toBe(true); // unknown field preserved
    // Their timeout is theirs — never normalized to BirdyBeep's.
    const hooks = entry["hooks"] as unknown[];
    expect(asRecord(hooks[0])["timeout"]).toBe(42);
  });

  it("still drops an entry that held nothing but ours (no empty husk left behind)", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    await installCodex({ dataDir: sb.path("data") }, sb.home);
    // SessionStart holds only BirdyBeep's entry.
    expect(entriesFor(readConfig(sb.home), "SessionStart")).toHaveLength(1);

    await uninstallCodex({ dataDir: sb.path("data") }, sb.home);
    expect(existsSync(codexConfigFile({ home: sb.home }))).toBe(false); // whole file was ours
  });

  it("byte-for-byte restore of a pre-existing config still holds", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    const original = [
      'model = "o3"',
      "",
      "[[hooks.PostToolUse]]",
      'matcher = ""',
      "",
      "[[hooks.PostToolUse.hooks]]",
      'type = "command"',
      'command = "my-own-codex-hook"',
      "",
    ].join("\n");
    const path = codexConfigFile({ home: sb.home });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, original);

    await installCodex({ dataDir: sb.path("data") }, sb.home);
    await uninstallCodex({ dataDir: sb.path("data") }, sb.home);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("a user command sharing the entry survives even when it is the FIRST hook listed", async () => {
    sandbox = createSandbox();
    const sb = sandbox;
    await installCodex({ dataDir: sb.path("data") }, sb.home);
    const config = readConfig(sb.home);
    const entries = entriesFor(config, "PermissionRequest");
    const ours = entries.findIndex(isBirdyBeepHookEntry);
    const entry = asRecord(entries[ours]);
    // Theirs first, ours second — order must not decide who survives.
    entries[ours] = {
      ...entry,
      hooks: [{ type: "command", command: USER_COMMAND }, ...(entry["hooks"] as unknown[])],
    };
    const hooksBlock = asRecord(config["hooks"]);
    hooksBlock["PermissionRequest"] = entries;
    const { stringify } = await import("smol-toml");
    writeFileSync(
      codexConfigFile({ home: sb.home }),
      `${stringify({ ...config, hooks: hooksBlock })}\n`,
    );

    await uninstallCodex({ dataDir: sb.path("data") }, sb.home);
    const kept = entriesFor(readConfig(sb.home), "PermissionRequest");
    expect(kept).toHaveLength(1);
    expect(commandsIn(kept[0])).toEqual([USER_COMMAND]);
  });
});

describe("gcgp.19: the predicates the fix rests on", () => {
  it("isBirdyBeepHook matches the INNER hook, not the entry", () => {
    expect(isBirdyBeepHook({ type: "command", command: "birdybeep hook codex" })).toBe(true);
    expect(isBirdyBeepHook({ type: "command", command: USER_COMMAND })).toBe(false);
    // An ENTRY is not an inner hook — passing one must not match.
    expect(isBirdyBeepHook({ hooks: [{ type: "command", command: "birdybeep hook codex" }] })).toBe(
      false,
    );
  });

  it("isBirdyBeepHookEntry stays entry-CONTAINS-ours (used to find, never to delete)", () => {
    const shared = {
      matcher: "",
      hooks: [
        { type: "command", command: USER_COMMAND },
        { type: "command", command: "birdybeep hook codex" },
      ],
    };
    expect(isBirdyBeepHookEntry(shared)).toBe(true);
    expect(isBirdyBeepHookEntry({ matcher: "", hooks: [{ command: USER_COMMAND }] })).toBe(false);
  });

  it("recognizes an absolute-launcher command as ours (gcgp.16 shapes)", () => {
    const command = '"/usr/local/bin/node" "/opt/pnpm/birdybeep" hook codex';
    expect(isBirdyBeepHook({ type: "command", command })).toBe(true);
    // …and never claims a third party's hook that merely mentions a harness.
    expect(isBirdyBeepHook({ type: "command", command: "other-tool hook codex" })).toBe(false);
  });
});
