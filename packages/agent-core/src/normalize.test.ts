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
  redactSecrets,
  scrubAbsolutePaths,
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

// birdybeep-agent-yop: absolute paths with SPACES / ~ / UNC / drive letters must be hashed
// WHOLE — the old regex leaked the tail after the first space (`Work/acme/.env`) and missed
// UNC entirely. Each case lists the fragments that MUST NOT survive anywhere in the payload.
describe("absolute-path scrub covers spaces / ~ / UNC / drive (yop)", () => {
  const cases: { name: string; path: string; leaks: string[] }[] = [
    {
      name: "POSIX path with a space (the reported leak)",
      path: "/Users/alice/Client Work/acme/.env.production",
      // "Work" is the bare dir word the PRE-FIX regex left behind: it hashed `/Users/alice/Client`
      // and `/acme/.env.production` around the space and forwarded the middle word verbatim. That
      // bare fragment — not "Client Work"/"Work/acme" (both absent pre-fix once the neighbours are
      // hashed) — is what actually leaked and what pins the fix.
      leaks: ["Work", "Client Work", "Work/acme", "acme", ".env.production", "/Users/alice"],
    },
    {
      name: "~ expansion with a spaced dir (Application Support)",
      path: "~/Library/Application Support/birdybeep/token.json",
      // "Support" is the bare dir word the PRE-FIX regex left behind after hashing
      // `/Library/Application` and `/birdybeep/token.json` around the space ("Application" is
      // consumed into the first hash; "Support" survives). It pins the fix.
      leaks: ["Support", "Application", "Application Support", "birdybeep", "token.json"],
    },
    {
      name: "UNC share with a spaced dir",
      path: "\\\\fileserver\\Team Share\\secrets\\prod.key",
      leaks: ["fileserver", "Team Share", "secrets", "prod.key"],
    },
    {
      name: "Windows drive with a spaced dir",
      path: "C:\\Users\\alice\\My Documents\\creds.txt",
      leaks: ["My Documents", "creds.txt", "Users\\alice"],
    },
    {
      name: "single-segment absolute path (>=2-segment floor dropped)",
      path: "/etc/passwd",
      leaks: ["/etc/passwd", "/etc", "passwd"],
    },
    {
      name: "multiple odd space-separated segments",
      path: "/srv/data/Client A/report Q3/final draft.xlsx",
      leaks: ["Client A", "report Q3", "final draft.xlsx"],
    },
  ];

  it.each(cases)("hashes $name with no fragment leak", ({ path, leaks }) => {
    // The scrubber alone must remove the whole run (regression at the unit boundary).
    const scrubbed = scrubAbsolutePaths(`edited ${path} just now`);
    for (const frag of leaks) expect(scrubbed).not.toContain(frag);

    // …and end-to-end through normalizeEvent in every carrier field the adapter forwards.
    const ev = normalizeEvent({
      ...baseDraft,
      source_session_id: `sess ${path}`,
      title: `touched ${path}`,
      body: `read from ${path} while running`,
      metadata: { file: path, nested: { also: path } },
    });
    const serialized = JSON.stringify(ev);
    for (const frag of leaks) expect(serialized).not.toContain(frag);
  });

  it("does NOT hash slash-glued prose (and/or, fractions, URLs) — precision", () => {
    const text = "use read/write and/or 1/2 ratio, TCP/IP at 24/7, see https://ex.com/a/b/c";
    expect(scrubAbsolutePaths(text)).toBe(text);
  });
});

// birdybeep-agent-yop (glued-lead fix): the PR anchored a POSIX root at a boundary to stop
// `and/or`/`1/2` false positives — but that lookbehind REGRESSED real paths glued to `:` `@`
// a letter or a digit, which then left the machine un-hashed: scp `user@host:/path`, `file:/path`,
// `from/Users/…`, `9/Users/…`. Each case lists PATH fragments that MUST NOT survive in any field
// the adapter forwards. (These fail against the current-PR regex and pass after the broadening.)
describe("absolute-path scrub covers colon/letter/digit-glued paths (yop glued-lead)", () => {
  const cases: { name: string; input: string; leaks: string[] }[] = [
    {
      name: "scp user@host:/abs/path (colon-glued)",
      input: "backup to user@host:/Users/alice/.ssh/id_rsa now",
      leaks: ["/Users/alice", "Users/alice", ".ssh", "id_rsa"],
    },
    {
      name: "scp git remote host:/abs/path",
      input: "clone git@github.com:/Users/alice/ClientCorp/deploy.pem here",
      leaks: ["/Users/alice", "ClientCorp", "deploy.pem"],
    },
    {
      name: "file: scheme, single slash (not a // URL)",
      input: "open file:/Users/alice/vault/.env.production",
      leaks: ["/Users/alice", "vault", ".env.production"],
    },
    {
      name: "letter-glued absolute path",
      input: "loaded config from/Users/alice/project-x/keychain.db ok",
      leaks: ["/Users/alice", "project-x", "keychain.db"],
    },
    {
      name: "digit-glued absolute path",
      input: "worker 9/Users/alice/scratchpad/output.log flushed",
      leaks: ["/Users/alice", "scratchpad", "output.log"],
    },
  ];

  it.each(cases)("hashes $name with no path fragment leak", ({ input, leaks }) => {
    // The scrubber alone must remove the whole path run (regression pinned at the unit boundary).
    const scrubbed = scrubAbsolutePaths(input);
    for (const frag of leaks) expect(scrubbed).not.toContain(frag);

    // …and end-to-end through normalizeEvent in every carrier field the adapter forwards.
    const ev = normalizeEvent({
      ...baseDraft,
      source_session_id: input,
      title: input,
      body: `context: ${input}`,
      metadata: { line: input, nested: { also: input } },
    });
    const serialized = JSON.stringify(ev);
    for (const frag of leaks) expect(serialized).not.toContain(frag);
  });

  it("preserves a real http(s) URL while still hashing a glued path beside it", () => {
    const out = scrubAbsolutePaths(
      "see https://ex.com/a/b/c then open file:/Users/alice/vault/.env",
    );
    expect(out).toContain("https://ex.com/a/b/c"); // URL untouched (its /a/b/c is remote)
    expect(out).not.toContain("/Users/alice"); // the glued local path is hashed
    expect(out).not.toContain("vault");
    expect(out).not.toContain(".env");
  });
});

// birdybeep-agent-yop/zov (pipeline ordering): scrubAbsolutePaths now runs on the redactSecrets
// OUTPUT, so base64 secret material containing `/` (and `+`) is redacted WHOLE before any path
// scanning — it can no longer be partly path-hashed into a `prefix+h_<hex>` remnant that slips
// under the 28-char entropy floor and leaks the prefix. This suite fails under the old
// scrub-then-redact order (the prefix `kJ8nQ2rV` survives) and passes after redact-then-scrub.
describe("secret-then-path ordering is robust for base64 with slashes (yop/zov)", () => {
  // Split so no contiguous secret literal sits in this source file (push-protection scanners).
  const b64Secret = "kJ8nQ2rV" + "+/aX7bC9dE/fG1hI4jK6lM0nP5qR3sT8uW2yZ/bD7";
  const prefix = "kJ8nQ2rV"; // the readable head a naive scrub-first pass would leave behind

  it("redacts the whole contiguous base64 run (detector sees it before any /-splitting)", () => {
    expect(redactSecrets(b64Secret)).toBe("[redacted]");
  });

  it("leaves no base64 fragment and no path-hash splice end-to-end", () => {
    const ev = normalizeEvent({
      ...baseDraft,
      title: b64Secret,
      body: `key material: ${b64Secret} <-`,
      metadata: { secret: b64Secret, nested: { also: b64Secret } },
    });
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain(prefix); // the head must not survive
    expect(serialized).not.toContain("aX7bC9dE"); // nor any interior chunk
    // The field that held ONLY the secret redacts to the marker — not a `prefix+h_<hex>` splice.
    expect((ev.metadata as Record<string, unknown>)["secret"]).toBe("[redacted]");
  });
});

// birdybeep-agent-zov: broaden secret detection; truncation is NOT a redaction backstop.
// NB: every fixture is concatenated from a prefix + body so the FULL literal never appears in
// this source file — otherwise secret scanners (GitHub push protection) reject the commit. The
// runtime value is the joined string, so it still exercises the real detectors.
describe("secret redaction is broad and position-independent (zov)", () => {
  const secrets: { name: string; value: string }[] = [
    { name: "Google API key", value: "AIza" + "SyDaB3dEfGhIjKlMnOpQrStUvWxYz012345678" },
    { name: "Google OAuth token", value: "ya29." + "a0Ae4lvC-9xQwErTyUiOpAsDfGhage123456" },
    { name: "Stripe live secret key", value: "sk_live_" + "51ABCdefGHIjklMNOpqrST0123" },
    { name: "Stripe restricted key", value: "rk_live_" + "9ZyXwVuTsRqPoNmLkJi0123" },
    { name: "Stripe webhook secret", value: "whsec_" + "ABCdef0123456789ghIJklMNop" },
    { name: "GitLab PAT", value: "glpat-" + "ABCdef1234567890xyzXY" },
    { name: "GitHub fine-grained PAT", value: "github_pat_" + "11ABCDE0000abcdefFGHIJ_klmnopQRST" },
    { name: "Slack app-level token", value: "xapp-1-" + "A012345678-9876543210-abcdefABCDEF" },
    { name: "Anthropic key", value: "sk-ant-" + "api03-AbCdEf0123456789ghIJkl" },
    { name: "AWS access key id", value: "AKIA" + "1234567890ABCDEF" },
    {
      name: "AWS secret access key (generic entropy)",
      value: "wJalrXUtnFEMI/" + "K7MDENG+bPxRfiCYEXAMPLEKEY",
    },
    {
      name: "64-char hex API key (generic entropy)",
      value: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    },
  ];

  it.each(secrets)("redacts a $name anywhere in the payload", ({ value }) => {
    expect(redactSecrets(`credential ${value} end`)).not.toContain(value);
    const ev = normalizeEvent({
      ...baseDraft,
      title: value,
      body: `token is ${value} do not log`,
      metadata: { key: value, nested: { also: value } },
    });
    expect(JSON.stringify(ev)).not.toContain(value);
  });

  it("redacts a PEM private key block", () => {
    // Split so no contiguous key material sits in this source file (secret scanners).
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MII" +
      "EowIBAAKCAQEA1234567890abcdefGHIJKLMNOP\nqrstuvWXYZ+/=\n" +
      "-----END RSA PRIVATE KEY-----";
    const ev = normalizeEvent({ ...baseDraft, body: `key:\n${pem}\nafter` });
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain("EowIBAAKCAQEA");
    expect(serialized).not.toContain("PRIVATE KEY-----\nMII");
  });

  it("a secret at the START of a long body is redacted, NOT merely truncated away", () => {
    const secret = "sk-proj-" + "Abcdefghijklmnop0123456789";
    const body = `${secret} ${"filler ".repeat(2000)}`; // secret sits well inside the retained head
    const ev = normalizeEvent({ ...baseDraft, body });
    expect(ev.body.length).toBeLessThanOrEqual(BODY_MAX_CHARS); // truncation still applied…
    expect(JSON.stringify(ev)).not.toContain(secret); // …but redaction is what removed the secret
  });

  it("does NOT redact ordinary long text (no false positives)", () => {
    const benign = "thisIsALongCamelCaseVariableNameUsedForConfiguration";
    const sentence = "the quick brown fox jumps over the lazy dog several times over";
    const out = redactSecrets(`${benign} :: ${sentence}`);
    expect(out).toContain(benign);
    expect(out).toContain(sentence);
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
