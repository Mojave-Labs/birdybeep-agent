---
"@birdybeep/agent-core": patch
"@birdybeep/claude-code": patch
"@birdybeep/codex": patch
"@birdybeep/copilot": patch
"@birdybeep/cursor": patch
"@birdybeep/opencode": patch
"@birdybeep/cli": patch
---

Report coverage per harness build, so a desktop app that never beeps stops looking installed

`birdybeep doctor` and `birdybeep status` now list every installed build of each harness on its
own row, with the version that build actually runs:

```
✓  Claude Code: terminal CLI 2.1.227 — covered — 1 event(s) from this build
✗  Claude Code: Claude desktop app 2.1.229 — not covered — nothing has ever fired from this
   build, while terminal CLI 2.1.227 is delivering through the same config
```

A harness is not one program. The terminal CLI and the engine a desktop app spawns are separate
installs on separate update channels, and they share one config file — so "hooks installed" was a
single answer covering both, and a desktop app that could not run the hook command looked exactly
like one that could.

- Detection returns a surface list: `claude` on PATH and the builds under
  `~/Library/Application Support/Claude/claude-code`; every `codex` on PATH and the one inside
  ChatGPT.app; `cursor-agent` and Cursor.app. Versions are read from the filesystem — no engine is
  run, because a `--version` probe answers for whichever build is first on PATH.
- Coverage is graded on events actually observed from each build, not on config presence. A build
  is only reported as a gap once another build of the same harness is delivering and it still is
  not; a shadowed PATH install is never blamed for not firing.
- Codex, Copilot and OpenCode gained the stale-launcher check Claude Code and Cursor already had.
  OpenCode's is different in kind: it reports the launcher record its plugin spawns, since a
  missing one silently falls back to a `PATH` lookup that drops events with no error.
- `birdybeep doctor` tells a migrated Codex user that turn-complete beeps are OFF right now,
  rather than the first-install wording.

Desktop surfaces are reported on macOS, where the layouts are known. Elsewhere the terminal rows
are reported and no desktop path is guessed.
