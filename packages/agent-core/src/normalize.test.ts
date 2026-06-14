/**
 * CORE-NORMALIZE proof: the privacy invariants, proven not inspected. The headline
 * is the NO-LEAK suite — after normalization, the serialized event contains zero
 * absolute paths and zero injected secrets, is under the size cap, and validates.
 */
import { describe, expect, it } from "vitest";

import { birdyBeepAgentEventSchema } from "./event";
import {
  BODY_MAX_CHARS,
  METADATA_VALUE_MAX_CHARS,
  NormalizeError,
  normalizeEvent,
  TITLE_MAX_CHARS,
} from "./normalize";
import { isWithinMaxAgentEventSize, MAX_AGENT_EVENT_BYTES } from "./primitives";

/** Absolute path detector used to PROVE nothing leaks (POSIX ≥2 segments or Windows drive). */
const ABSOLUTE_PATH = /(?:\/[A-Za-z0-9_.-]+){2,}|[A-Za-z]:[\\/][A-Za-z0-9_./\\ -]+/;

const baseDraft = {
  event_type: "approval_required",
  harness: "claude_code",
  source_session_id: "sess_1",
  machine: { label: "Box", os: "macos" },
  workspace: { cwd: "/Users/alex/code/app", repo_name: "app", branch: "main" },
  status: "waiting_for_approval",
  title: "needs approval",
  body: "running npm test",
};

describe("defaults + validity", () => {
  it("fills event_id + occurred_at and returns a valid event", () => {
    const ev = normalizeEvent(baseDraft);
    expect(birdyBeepAgentEventSchema.safeParse(ev).success).toBe(true);
    expect(ev.event_id.length).toBeGreaterThan(0);
    expect(() => new Date(ev.occurred_at).toISOString()).not.toThrow();
  });

  it("honors injected clock + id for determinism", () => {
    const ev = normalizeEvent(baseDraft, {
      now: () => "2026-06-14T00:00:00.000Z",
      generateId: () => "evt_fixed",
    });
    expect(ev.event_id).toBe("evt_fixed");
    expect(ev.occurred_at).toBe("2026-06-14T00:00:00.000Z");
  });

  it("preserves a caller-provided event_id / occurred_at", () => {
    const ev = normalizeEvent({
      ...baseDraft,
      event_id: "evt_keep",
      occurred_at: "2026-01-02T03:04:05.000Z",
    });
    expect(ev.event_id).toBe("evt_keep");
    expect(ev.occurred_at).toBe("2026-01-02T03:04:05.000Z");
  });

  it("throws NormalizeError when the result cannot validate (bad event_type)", () => {
    expect(() => normalizeEvent({ ...baseDraft, event_type: "not_real" })).toThrow(NormalizeError);
  });

  it("does not mutate its input", () => {
    const input = structuredClone(baseDraft);
    normalizeEvent(input);
    expect(input).toEqual(baseDraft);
  });
});

describe("path hashing (§14.5 / §15)", () => {
  it("hashes workspace.cwd and keeps safe labels", () => {
    const ev = normalizeEvent(baseDraft);
    expect(ev.workspace.cwd).toMatch(/^h_[0-9a-f]{16}$/);
    expect(ev.workspace.cwd).not.toContain("/Users/alex");
    expect(ev.workspace.repo_name).toBe("app");
    expect(ev.workspace.branch).toBe("main");
  });

  it("is stable: same path → same hash across runs", () => {
    const a = normalizeEvent(baseDraft).workspace.cwd;
    const b = normalizeEvent(baseDraft).workspace.cwd;
    expect(a).toBe(b);
  });

  it("scrubs absolute paths embedded in title / body / source_session_id / metadata", () => {
    const ev = normalizeEvent({
      ...baseDraft,
      source_session_id: "/Users/alex/.claude/transcripts/x.jsonl",
      title: "edited /Users/alex/secret/creds.txt",
      body: "see C:\\Users\\alex\\AppData\\Roaming\\secret.json and /etc/passwd/shadow",
      metadata: { tool: "Edit", command_summary: "patch /home/alex/app/src/index.ts" },
    });
    expect(ABSOLUTE_PATH.test(JSON.stringify(ev))).toBe(false);
  });
});

describe("secret redaction (best-effort; truncation is the backstop)", () => {
  it("redacts common secret shapes anywhere in the payload", () => {
    const secrets = [
      "ghp_0123456789abcdefghijABCDEF",
      "sk-0123456789abcdefABCD",
      "AKIA1234567890ABCDEF",
      "password=hunter2",
      "eyJhbGciOiJ.eyJzdWIiOiI.sIgnAtUreXyz",
    ];
    const ev = normalizeEvent({
      ...baseDraft,
      title: secrets[0],
      body: secrets.slice(1, 4).join(" "),
      metadata: { note: secrets[4] },
    });
    const serialized = JSON.stringify(ev);
    for (const s of secrets) expect(serialized).not.toContain(s);
  });
});

describe("truncation (§9.2)", () => {
  it("truncates title / body / metadata string values to their caps", () => {
    const ev = normalizeEvent({
      ...baseDraft,
      title: "T".repeat(1000),
      body: "B".repeat(10_000),
      metadata: { note: "M".repeat(5000) },
    });
    expect(ev.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(ev.body.length).toBeLessThanOrEqual(BODY_MAX_CHARS);
    const note = (ev.metadata as Record<string, unknown>)["note"];
    expect(typeof note).toBe("string");
    expect((note as string).length).toBeLessThanOrEqual(METADATA_VALUE_MAX_CHARS);
  });
});

describe("size cap (§13.5)", () => {
  it("forces an over-cap payload under the cap and keeps it valid", () => {
    const huge: Record<string, string> = {};
    for (let i = 0; i < 4000; i++) huge[`k${i}`] = "x".repeat(100);
    const ev = normalizeEvent({ ...baseDraft, metadata: huge });
    expect(isWithinMaxAgentEventSize(Buffer.byteLength(JSON.stringify(ev), "utf8"))).toBe(true);
    expect(birdyBeepAgentEventSchema.safeParse(ev).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(ev), "utf8")).toBeLessThanOrEqual(
      MAX_AGENT_EVENT_BYTES,
    );
  });
});

describe("metadata is an open record but bounded", () => {
  it("accepts nested structures and scrubs their string leaves", () => {
    const ev = normalizeEvent({
      ...baseDraft,
      metadata: { tool: "Bash", nested: { path: "/var/log/app/run.log", count: 3, ok: true } },
    });
    expect(birdyBeepAgentEventSchema.safeParse(ev).success).toBe(true);
    expect(ABSOLUTE_PATH.test(JSON.stringify(ev.metadata))).toBe(false);
  });
});

describe("no-leak invariant over many adversarial inputs", () => {
  it("never emits an absolute path or exceeds the cap across generated drafts", () => {
    const paths = [
      "/Users/jane/dev/secret-project/.env",
      "/home/ci/runner/work/repo/token.txt",
      "C:\\Users\\dev\\AppData\\Local\\keys.json",
      "/private/var/folders/zz/T/leak",
      "/opt/app/config/credentials.yml",
    ];
    for (let i = 0; i < 200; i++) {
      const p = paths[i % paths.length]!;
      const ev = normalizeEvent({
        ...baseDraft,
        source_session_id: `sess_${i}_${p}`,
        title: `event ${i} at ${p}`,
        body: `processing ${p} repeatedly `.repeat((i % 50) + 1),
        metadata: { i, where: p, deep: { also: p, list: [p, p, p] } },
      });
      const serialized = JSON.stringify(ev);
      expect(ABSOLUTE_PATH.test(serialized)).toBe(false);
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_AGENT_EVENT_BYTES);
      expect(birdyBeepAgentEventSchema.safeParse(ev).success).toBe(true);
    }
  });
});
