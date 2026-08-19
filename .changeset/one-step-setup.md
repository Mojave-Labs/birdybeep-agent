---
"@birdybeep/cli": minor
---

Setting up is one command: `birdybeep setup` pairs, wires up every coding agent, and shows what will beep

Pairing used to end at "Run `birdybeep test`". The Beep arrived, and a machine with no harness
installed looked finished. Pairing now runs the whole job:

```text
✓ Paired to you@example.com.

coverage
   harness             build                        state
✓  Claude Code         terminal CLI 2.1.227         ready
✓  Claude Code         Claude desktop app 2.1.229   ready
!  Codex               terminal CLI 0.147.0         needs you
     → Codex may require one-time hook trust. Open Codex and run /hooks.
–  OpenCode            —                            not installed

Not installed: OpenCode. Install any of them, then run `birdybeep setup` again to wire it up.

✓ Test event delivered — check your phone for a test Beep.
```

- `birdybeep setup` is the new verb, featured in a "Getting started" block at the top of
  `birdybeep --help`. `birdybeep pair` runs the identical flow; `setup` additionally skips the
  phone step on a machine that already has a token, so re-running it after installing a harness
  costs one command.
- The coverage table is one row per installed BUILD, so a desktop app's engine and a terminal CLI
  are graded apart. Codex's `/hooks` trust, an OpenCode restart, a `notify` slot another tool
  owns, a build that has never fired, and an install that errored are rows or lines under one —
  none of them are swallowed.
- A harness that is not installed says what to install and that re-running finishes the job. A
  machine with none of them says so instead of printing five skips.
- `birdybeep agent install` now says when the machine is unpaired (its hooks would reach nobody),
  and an undetected harness names the command that wires it up later.
- `--no-install` stops after the machine token; `--no-test` skips the closing Beep;
  `birdybeep agent install <harness>` still does one harness at a time.
