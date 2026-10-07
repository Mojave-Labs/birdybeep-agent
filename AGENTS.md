# Agent Instructions

> **READ `CLAUDE.md` FIRST — it is the canonical engineering contract for this repo.** Everything below is a supplement.

## 🪶 Agentic-first, and the one rule you cannot break
The human is only an **orchestrator and final-product tester**. You own design → implement → **verify against real harnesses** → ship. This CLI edits real config in users' home dirs and hooks into real coding agents, so **no code reaches `git push` until you've run it for real**: install/uninstall into an isolated temp `HOME`, fire actual Claude Code / Codex / OpenCode / Cursor / Copilot events, and assert the normalized event is delivered to a live `wrangler dev` backend — on the macOS/Linux/Windows matrix, with current config snapshots. A unit test of the mapper is necessary but **not sufficient**. "It should work" is a forbidden completion claim. A pre-push hook + CI **block** unverified pushes; never `--no-verify` or weaken a test. Tokens never get written to repo files. Full details in `CLAUDE.md`.

## Jira workflow

Jira project **BIRD** is the authoritative tracker for both BirdyBeep repositories:
https://mojavelabs.atlassian.net/jira/software/projects/BIRD/boards/103

- Use `repo-birdybeep` for the app/API/web repo and `repo-birdybeep-agent` for the CLI/adapters. Cross-repo work carries both labels.
- Read the live issue, acceptance criteria, **Testing (mandatory)** section, comments, parent and blockers before starting. Assign it and move it to **In Progress**.
- Write the test, snapshot or UI flow first where practical, implement, then exercise the real running product and inspect its output.
- Use BIRD for all task tracking; do not maintain a parallel task tracker in repository files.
- Historical issue IDs resolve through `docs/jira-issue-map.csv` or their full legacy-ID label in Jira. Use BIRD keys for new references.
- Keep scope, decisions, verification evidence, blockers and follow-ups on the Jira issue. Use native parent and dependency links.
- Preserve `blocked`, `deferred` and `human-required` labels where applicable. An issue with an unresolved blocker is not ready just because it is in To Do.
- Move an issue to **Done** only after the required real-product verification succeeds and the changes are committed and pushed. Keep physical-device, production and account-dependent acceptance explicit.
- Durable engineering context belongs in repository documentation or private Jira comments; never put credentials or private infrastructure details in the public agent repo.

## Session Completion

1. File remaining work in BIRD and record blockers and verification evidence.
2. Run the quality gates and real-product checks for every changed surface.
3. Commit, integrate current remote changes, and push with the normal pre-push hook. Never bypass or weaken a gate.
4. Verify the commits are on the remote and the working tree is clean; then update the Jira issue and hand off any remaining acceptance.

## ✍️ Writing style for user-facing text

Full rules in `CLAUDE.md`. The short version, for READMEs, `docs/`, npm descriptions, CLI output,
and error messages: answer what the reader is trying to do, then stop.

Never explain what this repo is relative to the product (public, open-source, MIT, auditable, "the
client half", or that a separate repo holds the app/backend). Never explain why a design decision
was made — that goes on the Jira issue. Cut "deliberately", "carefully", "by design", "robust",
"comprehensive", "seamless". State behavior in specifics rather than reassurance. Each fact lives
in exactly one document; link to it from anywhere else.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var
