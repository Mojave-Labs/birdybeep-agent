// BirdyBeep pre-push gate (A-PREPUSH) — fast local feedback that mirrors CI.
//
// Runs the always-on gates (changeset status + lint + typecheck + unit + format:check,
// exactly what CI enforces) and hard-blocks the push on any failure. The config-snapshot and adapter
// -smoke suites ride INSIDE `pnpm test` as they land (A-TEST-HARNESS / adapter
// tickets), so they are gated automatically without a separate step here — no
// hard-gating on suites that don't exist yet. CI + required status checks remain the
// authoritative, un-bypassable block; this hook just catches problems before they
// leave the machine. Chained AFTER beads sync via .beads/hooks/pre-push.
// Never --no-verify past a real failure.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Git exports repository-location overrides to hooks. In a linked worktree, carrying GIT_DIR into
// nested Git commands can make working-tree-aware tools inspect the primary checkout instead of the
// checkout being pushed. Let every child command rediscover this worktree from the current directory.
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_PREFIX;

const RED = "\x1b[31m";
const GRN = "\x1b[32m";
const YEL = "\x1b[33m";
const DIM = "\x1b[2m";
const RST = "\x1b[0m";
const B = "\x1b[1m";

function block(msg) {
  console.error(msg);
  process.exit(1);
}

/** Run a command, capture output, and return null when it fails (for probes, not gates). */
function probe(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// birdybeep-agent-uu5: changeset gate — the cheapest check, so it runs FIRST.
//
// Mirrors the CI `changeset status` job (.github/workflows/ci.yml): fetch the base branch,
// then `pnpm changeset status --since="origin/<base>"`, which exits non-zero when a changed
// PUBLISHABLE package carries no changeset. Everything else is exempt by construction, not by
// a special case here: a docs-only (or scripts-only, or CI-only) diff touches no package, so
// changesets finds nothing to bump and exits 0. `.changeset/config.json`'s `ignore` list
// (@birdybeep/test-harness) is honoured by changesets itself for the same reason.
//
// Two conditions CI expresses in YAML that have to be expressed here:
//   • the job is `pull_request`-only → skip when pushing the base branch itself (no PR base).
//   • `changeset-release/*` is exempt → that is the bot's Version PR, whose whole job is to
//     CONSUME the changesets, so the gate would fail on it by construction.
// The base branch comes from `.changeset/config.json` (`baseBranch`), the same value the
// changesets CLI defaults to and the branch every PR here is opened against. NOTE the one place
// this can diverge from CI: CI diffs against the PR's ACTUAL base ref (`$GITHUB_BASE_REF`), so a
// stacked PR (opened against another feature branch) is checked here against `main` instead of its
// real base. Harmless today — every PR here targets `main` — and CI stays authoritative either way.
const branch = probe("git rev-parse --abbrev-ref HEAD") ?? "HEAD";
let baseBranch = "main";
try {
  // Resolved against THIS file, not cwd, so the hook works from any working directory.
  const configPath = fileURLToPath(new URL("../.changeset/config.json", import.meta.url));
  baseBranch = JSON.parse(readFileSync(configPath, "utf8")).baseBranch ?? "main";
} catch {
  /* keep the default */
}

if (branch === baseBranch || branch.startsWith("changeset-release/")) {
  console.error(
    `${DIM}birdybeep pre-push → skipping changeset status (on ${branch}; CI runs it on PRs only)…${RST}`,
  );
} else {
  // CI's "Ensure the base branch is available for the diff" step, locally — and, like CI, the
  // fetch runs UNCONDITIONALLY (birdybeep-agent-97n). Fetching only when the ref was missing meant
  // a present-but-STALE refs/remotes/origin/<base> was used as-is, so the gate diffed against an
  // old base and could pass locally while CI — which always fetches — failed on the same push.
  const fetched = probe(`git fetch origin ${baseBranch}`) !== null;
  const baseRef = probe(`git rev-parse --verify --quiet refs/remotes/origin/${baseBranch}`);
  if (baseRef === null) {
    // Offline / no remote and nothing cached: warn, don't block. CI re-runs this as a required
    // check anyway.
    console.error(
      `${YEL}! birdybeep pre-push → could not resolve origin/${baseBranch}; skipping changeset status.${RST}\n` +
        `  ${DIM}The CI 'changeset status' check will still enforce it on the PR.${RST}`,
    );
  } else {
    if (!fetched) {
      // Offline but the tracking ref is cached: degrade to a warning and check against the
      // (possibly stale) local base rather than blocking a push we can't fairly judge.
      console.error(
        `${YEL}! birdybeep pre-push → could not fetch origin/${baseBranch}; using the cached ref, which may be stale.${RST}\n` +
          `  ${DIM}The CI 'changeset status' check re-runs this against the real base on the PR.${RST}`,
      );
    }
    console.error(
      `${DIM}birdybeep pre-push → changeset status (--since=origin/${baseBranch}, mirrors CI)…${RST}`,
    );
    // Caveat: `changeset status --since` diffs the WORKING TREE, not the committed range, so an
    // uncommitted edit to a publishable package can block a push whose committed diff is exempt.
    // Commit or stash it and push again — CI only ever sees the committed diff.
    try {
      execSync(`pnpm changeset status --since="origin/${baseBranch}"`, { stdio: "inherit" });
    } catch {
      block(
        `\n${RED}${B}✗ push blocked${RST} — a changed package has no changeset (this is the CI 'changeset status' check).\n` +
          `  Run ${B}pnpm changeset${RST} to describe the change, commit the generated ${B}.changeset/*.md${RST}, then push again.\n` +
          `  ${DIM}Docs-only / tooling-only diffs touch no package and need no changeset.${RST}`,
      );
    }
  }
}

// Always-on gates — mirror CI. Run on EVERY push.
console.error(`${DIM}birdybeep pre-push → lint + typecheck + unit + format (mirrors CI)…${RST}`);
try {
  execSync("pnpm -w test:scripts", { stdio: "inherit" });
  execSync("pnpm -w turbo run lint typecheck test", { stdio: "inherit" });
  execSync("node scripts/staging-e2e.mjs --local-self-test", { stdio: "inherit" });
} catch {
  block(
    `\n${RED}${B}✗ push blocked${RST} — lint/typecheck/unit failed (these mirror the CI gates).\n` +
      `  Fix the failures above, then push again. Do not bypass with --no-verify.`,
  );
}
try {
  execSync("pnpm -w format:check", { stdio: "inherit" });
} catch {
  block(
    `\n${RED}${B}✗ push blocked${RST} — Prettier formatting check failed.\n` +
      `  Run ${B}pnpm format${RST} to fix formatting, then push again.`,
  );
}

console.error(`${GRN}${B}✓ birdybeep pre-push passed${RST}`);
process.exit(0);
