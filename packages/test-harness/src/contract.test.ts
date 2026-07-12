// Tests for the real-home escape oracle (birdybeep-agent-2wt).
//
// The oracle answers ONE question: "did the install under test reach outside its
// sandbox and touch the user's real home?" The original version answered it by
// asking whether a set of uniquely-BirdyBeep paths EXIST in the real home — which
// is wrong on precisely the machines that matter most: a developer who has actually
// run `birdybeep install` legitimately HAS a `settings.json.birdybeep-backup` sitting
// in their real home, so the "escape" assertion fired on every dogfooding machine
// (and would fire on any real user's machine) while no escape had occurred.
//
// The fix is to detect MUTATION, not existence: snapshot the watched paths before
// the install, and assert they are byte-identical afterwards.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertRealHomeUnchanged, snapshotRealHome } from "./contract";

const SETTINGS = ".claude/settings.json";
const BACKUP = ".claude/settings.json.birdybeep-backup";
const TOKEN = ".config/birdybeep/token";
const WATCHED = [SETTINGS, BACKUP, TOKEN];

describe("real-home escape oracle", () => {
  let home: string;

  const write = (rel: string, body: string): void => {
    const abs = join(home, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bb-realhome-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // The regression this ticket is about.
  it("passes on a machine where BirdyBeep is legitimately installed and nothing is touched", () => {
    // A real dogfooding home: settings.json references birdybeep AND the install's
    // backup file is sitting right there. Under the old existence-based oracle this
    // alone counted as an "escape".
    write(SETTINGS, '{"hooks":{"Notification":"birdybeep hook claude-code"}}');
    write(BACKUP, '{"hooks":{}}');
    write(TOKEN, "durable-token");

    const before = snapshotRealHome(home, WATCHED);
    // ...an install runs, correctly confined to its sandbox: real home untouched.
    expect(() => assertRealHomeUnchanged(before)).not.toThrow();
  });

  it("passes when the watched paths are absent before and after", () => {
    const before = snapshotRealHome(home, WATCHED);
    expect(() => assertRealHomeUnchanged(before)).not.toThrow();
  });

  // Still catches a genuine escape — in all three shapes.
  it("fails when an escaping install CREATES a file in the real home", () => {
    const before = snapshotRealHome(home, WATCHED);
    write(BACKUP, '{"hooks":{}}'); // escape: install wrote its backup to the real home
    expect(() => assertRealHomeUnchanged(before)).toThrow(
      /escaped the sandbox and CREATED.*backup/s,
    );
  });

  it("fails when an escaping install MODIFIES a pre-existing real-home file", () => {
    write(SETTINGS, '{"hooks":{}}');
    const before = snapshotRealHome(home, WATCHED);
    write(SETTINGS, '{"hooks":{"Notification":"birdybeep hook claude-code"}}'); // escape: patched the real settings
    expect(() => assertRealHomeUnchanged(before)).toThrow(
      /escaped the sandbox and MODIFIED.*settings\.json/s,
    );
  });

  it("fails when an escaping install DELETES a real-home file", () => {
    write(SETTINGS, '{"hooks":{}}');
    const before = snapshotRealHome(home, WATCHED);
    rmSync(join(home, SETTINGS)); // escape: clobbered the real config
    expect(() => assertRealHomeUnchanged(before)).toThrow(
      /escaped the sandbox and DELETED.*settings\.json/s,
    );
  });
});
