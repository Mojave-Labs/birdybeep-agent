import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_PAIRING_DOCS = [
  "README.md",
  "docs/install.md",
  "docs/pairing.md",
  "docs/security.md",
  "docs/SPEC.md",
  "docs/troubleshooting.md",
];

const MANUAL_CODE_GUIDANCE = [
  /\b(?:enter|type)\s+(?:the\s+|a\s+)?(?:short\s+)?(?:pairing\s+)?code\b/i,
  /\bshort (?:url|link)\s*(?:\+|and)\s*(?:a\s+)?code\b/i,
  /\bqr\s*\/\s*code\b/i,
  /\bqr\s+or\s+code\b/i,
];

test("public pairing docs never advertise code-only approval", () => {
  for (const relativePath of PUBLIC_PAIRING_DOCS) {
    const text = readFileSync(join(REPO, relativePath), "utf8");
    for (const forbidden of MANUAL_CODE_GUIDANCE) {
      assert.doesNotMatch(text, forbidden, `${relativePath} contains stale manual-code guidance`);
    }
  }
});

test("the pairing guide documents the complete secret-bearing link", () => {
  const pairing = readFileSync(join(REPO, "docs/pairing.md"), "utf8");
  assert.match(pairing, /#code=.*&s=/);
  assert.match(pairing, /display only; cannot approve by itself/i);
  assert.match(pairing, /copy the complete link.*including everything after `#`/i);
});
