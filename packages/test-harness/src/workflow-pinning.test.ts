// Supply-chain guard: every third-party GitHub Action must be pinned to a full
// commit SHA (birdybeep-agent-mj8).
//
// The release workflow hands `NPM_TOKEN` and an OIDC `id-token` to the actions it
// runs. A tag-pinned action (`changesets/action@v1`) is a MUTABLE reference: the
// upstream owner — or anyone who compromises them — can retarget `v1` at new code,
// and our next release run executes it with publish credentials in scope, with no
// diff in this repo to review. A 40-hex SHA is immutable, so an upstream retag
// cannot change what we execute.
//
// This is a repo-hygiene invariant rather than a unit test of a function, and it
// lives here because test-harness is the private package already wired into the
// turbo `test` graph — so the pre-push hook and CI both enforce it. It scans .github
// by DISCOVERY, not against a hardcoded list, so a newly added workflow that reaches
// for an unpinned action fails this test instead of shipping.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// src -> test-harness -> packages -> repo root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GITHUB_DIR = join(REPO_ROOT, ".github");

const FULL_SHA = /^[0-9a-f]{40}$/;

interface UsesRef {
  /** Path of the workflow/action file, relative to the repo root. */
  file: string;
  /** 1-indexed line number, so a failure points straight at the offending line. */
  line: number;
  /** The raw value of `uses:` — e.g. "actions/checkout@v5". */
  value: string;
  /** The trailing `# ...` comment, if any — where the human-readable version lives. */
  comment: string | undefined;
}

/** Every .yml/.yaml under .github (workflows AND composite actions). */
function githubYamlFiles(): string[] {
  return readdirSync(GITHUB_DIR, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".yml") || rel.endsWith(".yaml"))
    .map((rel) => join(".github", rel))
    .sort();
}

/** Scan a file for `uses:` steps. Line-based on purpose: no YAML dep, and the
 *  trailing comment we assert on is a lexical detail a YAML parser would discard. */
function usesRefsIn(relPath: string): UsesRef[] {
  const refs: UsesRef[] = [];
  const lines = readFileSync(join(REPO_ROOT, relPath), "utf8").split(/\r?\n/);

  lines.forEach((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith("#")) return; // a commented-out step is not executed
    const m = /^-?\s*uses:\s*(\S+)\s*(?:#\s*(.*))?$/.exec(trimmed);
    if (!m) return;
    refs.push({
      file: relPath,
      line: i + 1,
      value: m[1]!,
      comment: m[2]?.trim() || undefined,
    });
  });

  return refs;
}

/** Local actions (`./.github/actions/setup`) are this repo's own code at this
 *  repo's own commit — there is no external ref to pin. Everything else is. */
const isLocal = (value: string): boolean => value.startsWith("./") || value.startsWith("../");

describe("GitHub Actions are pinned to immutable commit SHAs", () => {
  const allRefs = githubYamlFiles().flatMap(usesRefsIn);
  const external = allRefs.filter((r) => !isLocal(r.value));

  // A scan that silently matches nothing would make every assertion below
  // vacuously true. Anchor it: this repo really does use external actions.
  it("actually finds the workflows it claims to guard", () => {
    expect(githubYamlFiles()).toContain(join(".github", "workflows", "release.yml"));
    expect(external.length).toBeGreaterThanOrEqual(5);
  });

  it("pins every external action to a full 40-char commit SHA", () => {
    const unpinned = external
      .filter((r) => !FULL_SHA.test(r.value.split("@")[1] ?? ""))
      .map((r) => `${r.file}:${r.line} -> ${r.value}`);

    expect(unpinned).toEqual([]);
  });

  it("records the human-readable version in a trailing comment on every pin", () => {
    const undocumented = external
      .filter((r) => !r.comment)
      .map((r) => `${r.file}:${r.line} -> ${r.value} (needs a trailing '# vX.Y.Z')`);

    expect(undocumented).toEqual([]);
  });

  // The action holding NPM_TOKEN + the OIDC id-token is the crown jewel; call it
  // out by name so a regression here is unmistakable in the failure output.
  it("pins the changesets action that holds NPM_TOKEN and the OIDC id-token", () => {
    const changesets = external.filter((r) => r.value.startsWith("changesets/action@"));

    expect(changesets.length).toBe(1);
    expect(changesets[0]!.value.split("@")[1]).toMatch(FULL_SHA);
  });
});
