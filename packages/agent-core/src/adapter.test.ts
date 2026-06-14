/**
 * CORE-ADAPTER-IFACE proof: (1) a reference adapter is assignable to AgentAdapter
 * with no any/cast escapes; (2) a malformed adapter FAILS to compile (negative type
 * test via @ts-expect-error); (3) normalizeEvent returns a validated event; (4) the
 * §7.3 install contract holds — idempotent, backs up, only managed entries added,
 * uninstall restores byte-for-byte — run in a hermetic temp HOME. Every concrete
 * adapter (a-claude/codex/opencode) will later run this same contract.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  assertTreeDelta,
  assertTreesEqual,
  captureTree,
  createSandbox,
  type Sandbox,
} from "@birdybeep/test-harness";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AgentAdapter,
  birdyBeepAgentEventSchema,
  type InstallResult,
  INTEGRATION_STATUSES,
  normalizeEvent as runNormalize,
  type UninstallResult,
} from "./index";

const CONFIG_REL = ".birdybeep-ref/settings.json";
const BACKUP_REL = ".birdybeep-ref/settings.json.birdybeep-backup";

function configPath(): string {
  return join(homedir(), CONFIG_REL);
}
function backupPath(): string {
  return join(homedir(), BACKUP_REL);
}
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function isManaged(config: Record<string, unknown>): boolean {
  return asRecord(config["_birdybeep"])["managed"] === true;
}

/** A minimal, fully-typed adapter that satisfies AgentAdapter with no casts/any. */
const referenceAdapter: AgentAdapter = {
  id: "claude_code",
  displayName: "Reference Adapter",
  detect: () => Promise.resolve({ detected: true, configPath: configPath() }),
  install: (options = {}): Promise<InstallResult> => {
    const path = configPath();
    const backup = backupPath();
    const existed = existsSync(path);
    const raw = existed ? readFileSync(path, "utf8") : "";
    const parsed = raw.trim().length > 0 ? asRecord(JSON.parse(raw)) : {};
    if (isManaged(parsed)) {
      return Promise.resolve({
        changed: false,
        changedFiles: [],
        backupFiles: existsSync(backup) ? [backup] : [],
        requiredActions: [],
        status: "installed",
      });
    }
    if (options.dryRun) {
      return Promise.resolve({
        changed: false,
        changedFiles: [path],
        backupFiles: existed ? [backup] : [],
        requiredActions: ["run without --dry-run to apply"],
        status: "not_detected",
      });
    }
    mkdirSync(dirname(path), { recursive: true });
    if (existed) copyFileSync(path, backup);
    writeFileSync(
      path,
      `${JSON.stringify({ ...parsed, _birdybeep: { managed: true } }, null, 2)}\n`,
    );
    return Promise.resolve({
      changed: true,
      changedFiles: [path],
      backupFiles: existed ? [backup] : [],
      requiredActions: [],
      status: "installed",
    });
  },
  uninstall: (): Promise<UninstallResult> => {
    const path = configPath();
    const backup = backupPath();
    if (existsSync(backup)) {
      copyFileSync(backup, path);
      rmSync(backup, { force: true });
      return Promise.resolve({ changed: true, removedFiles: [], restoredFiles: [path] });
    }
    if (existsSync(path)) {
      rmSync(path, { force: true });
      return Promise.resolve({ changed: true, removedFiles: [path], restoredFiles: [] });
    }
    return Promise.resolve({ changed: false, removedFiles: [], restoredFiles: [] });
  },
  status: () => Promise.resolve(existsSync(configPath()) ? "installed" : "not_detected"),
  doctor: () =>
    Promise.resolve({ ok: true, checks: [{ name: "config", ok: true, status: "installed" }] }),
  normalizeEvent: (input) => Promise.resolve(runNormalize(input)),
};

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

describe("type conformance", () => {
  it("the reference adapter is assignable to AgentAdapter", () => {
    const adapter: AgentAdapter = referenceAdapter;
    expect(adapter.id).toBe("claude_code");
  });

  it("a malformed adapter fails to compile (negative type test)", () => {
    // @ts-expect-error - missing required methods (detect/install/.../normalizeEvent)
    const bad: AgentAdapter = { id: "claude_code", displayName: "broken" };
    expect(bad).toBeDefined();
  });

  it("IntegrationStatus enumerates exactly the §8.8 values", () => {
    expect([...INTEGRATION_STATUSES]).toEqual([
      "installed",
      "not_detected",
      "needs_restart",
      "needs_trust",
      "error",
      "revoked",
      "unknown",
    ]);
  });
});

describe("normalizeEvent returns a validated event", () => {
  it("produces a schema-valid BirdyBeepAgentEvent", async () => {
    const ev = await referenceAdapter.normalizeEvent({
      event_type: "agent_completed",
      harness: "claude_code",
      source_session_id: "s1",
      machine: { label: "box", os: "linux" },
      workspace: { cwd: "/tmp/x" },
      status: "completed",
      title: "done",
      body: "ok",
    });
    expect(birdyBeepAgentEventSchema.safeParse(ev).success).toBe(true);
  });
});

describe("install contract (§7.3) — run in a hermetic temp HOME", () => {
  it("backs up + adds only managed entries, is idempotent, and uninstall restores", async () => {
    sandbox = createSandbox();
    const dir = sandbox.path(".birdybeep-ref");
    const settings = sandbox.path(CONFIG_REL);
    const foreign = `${JSON.stringify({ theme: "dark" }, null, 2)}\n`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(settings, foreign);
    const before = captureTree(dir);

    const r1 = await referenceAdapter.install();
    expect(r1.changed).toBe(true);
    expect(r1.backupFiles.length).toBe(1);
    assertTreeDelta(before, captureTree(dir), {
      added: ["settings.json.birdybeep-backup"],
      changed: ["settings.json"],
    });
    expect(readFileSync(sandbox.path(BACKUP_REL), "utf8")).toBe(foreign); // backup byte-for-byte

    const afterInstall = captureTree(dir);
    const r2 = await referenceAdapter.install();
    expect(r2.changed).toBe(false); // idempotent
    assertTreesEqual(afterInstall, captureTree(dir), "second install must be a no-op");

    await referenceAdapter.uninstall();
    assertTreesEqual(before, captureTree(dir), "uninstall must restore the original");
    expect(readFileSync(settings, "utf8")).toBe(foreign);
  });
});
