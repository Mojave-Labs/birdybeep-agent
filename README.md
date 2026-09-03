# BirdyBeep

[![CI](https://img.shields.io/github/actions/workflow/status/Mojave-Labs/birdybeep-agent/ci.yml?branch=main&label=CI&logo=github&logoColor=white)](https://github.com/Mojave-Labs/birdybeep-agent/actions/workflows/ci.yml?query=branch%3Amain)
[![npm](https://img.shields.io/npm/v/%40birdybeep%2Fcli?logo=npm&label=%40birdybeep%2Fcli)](https://www.npmjs.com/package/@birdybeep/cli)
[![node](https://img.shields.io/node/v/%40birdybeep%2Fcli?logo=node.js&logoColor=white&label=node)](https://nodejs.org)
[![platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-informational)](https://github.com/Mojave-Labs/birdybeep-agent/actions/workflows/ci.yml?query=branch%3Amain)
[![license](https://img.shields.io/npm/l/%40birdybeep%2Fcli?color=blue)](./LICENSE)

BirdyBeep sends phone notifications when Claude Code, Codex, OpenCode, Cursor, or GitHub Copilot CLI needs your approval or input, finishes, goes idle, or fails.

## Install

```bash
npm install -g @birdybeep/cli
birdybeep setup
```

`birdybeep setup` connects this machine, installs adapters for detected coding agents, prints a coverage row for each installed build, and sends a test Beep. It skips pairing when a machine token already exists.

```text
✓ Paired to you@example.com.

coverage
   harness             build                        state
✓  Claude Code         terminal CLI 2.1.227         ready
✓  Claude Code         Claude desktop app 2.1.229   ready
!  Codex               terminal CLI 0.147.0         needs you
     → Open Codex and run /hooks. Status changes from needs_trust after a lifecycle hook fires.
–  OpenCode            —                            not installed

Not installed: OpenCode. Install it, then run `birdybeep setup` again.

✓ Test event accepted for 1 registered device(s). Check your phone for a test Beep.
```

Installers preserve existing configuration and write one backup before the first modification. Machine tokens remain in the OS keychain or a restricted fallback file.

Adapter files, activation requirements, and tested versions are listed in the [installation guide](./docs/install.md). Exact generated configuration is under [`examples/`](./examples/README.md).

## Commands

Run `birdybeep <command> --help` for command-specific options.

| Command                                                                     | Result                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `birdybeep setup`                                                           | Connect the machine, install detected adapters, show coverage, and send a test Beep.      |
| `birdybeep pair [--no-install] [--no-test]`                                 | Connect the machine to a BirdyBeep account, then install adapters and test.               |
| `birdybeep logout`                                                          | Delete the local machine token. The machine remains listed in the app.                    |
| `birdybeep unpair`                                                          | Revoke the machine on the server and delete its local token.                              |
| `birdybeep status`                                                          | Show pairing, adapter, and queue status.                                                  |
| `birdybeep test`                                                            | Send a test event and report whether it was delivered, queued, or rejected.               |
| `birdybeep doctor`                                                          | Check pairing, adapters, the queue, device reachability, quota, and backend reachability. |
| `birdybeep agent install [all\|claude\|codex\|opencode\|cursor\|copilot]`   | Install adapters for all detected harnesses or one selected harness.                      |
| `birdybeep agent uninstall [all\|claude\|codex\|opencode\|cursor\|copilot]` | Remove BirdyBeep-owned entries and restore configuration where appropriate.               |
| `birdybeep queue clear`                                                     | Delete locally queued events.                                                             |

`birdybeep hook <harness>` and `birdybeep report-status` are called by installed adapters rather than directly by users.

### Global flags and exit codes

| Flag                | Effect                                   |
| ------------------- | ---------------------------------------- |
| `--json`            | Machine-readable JSON output.            |
| `--non-interactive` | Never prompt; fail if input is required. |
| `-h`, `--help`      | Show help.                               |
| `-v`, `--version`   | Show the CLI version.                    |

Exit codes: `0` success, `1` error, `2` usage.

`birdybeep pair` also accepts:

| Flag                    | Effect                                                |
| ----------------------- | ----------------------------------------------------- |
| `--yes`, `-y`           | Accept the account that approved the pairing request. |
| `--expect-email <addr>` | Require an exact approving-account match.             |

The CLI checks npm for a newer release at most once a day. It skips the check for hook execution, JSON or non-interactive output, pipes, and CI. Disable notices with `NO_UPDATE_NOTIFIER=1` or `BIRDYBEEP_NO_UPDATE_NOTIFIER=1`. Updates are never installed automatically.

## Security and privacy

Exact event fields, filtering, token storage, and local queue behavior are documented in [Security and privacy](./docs/security.md).

## Uninstall

```bash
birdybeep agent uninstall all
birdybeep unpair
```

Uninstall removes BirdyBeep-owned entries. `unpair` revokes the machine on the server and deletes its local token. Use `birdybeep logout` when you only want to delete the local token.

## Documentation

| Document                                                       | Contents                                        |
| -------------------------------------------------------------- | ----------------------------------------------- |
| [`docs/install.md`](./docs/install.md)                         | Installation, adapter details, and removal.     |
| [`docs/pairing.md`](./docs/pairing.md)                         | Pairing and account confirmation.               |
| [`docs/security.md`](./docs/security.md)                       | Event fields, filtering, storage, and tokens.   |
| [`docs/troubleshooting.md`](./docs/troubleshooting.md)         | Diagnostic output and remedies.                 |
| [`docs/adapter-development.md`](./docs/adapter-development.md) | Adding and testing an adapter.                  |
| [`docs/SPEC.md`](./docs/SPEC.md)                               | CLI, adapter, event, and security requirements. |

## Packages

| Package                  | Description                  |
| ------------------------ | ---------------------------- |
| `@birdybeep/cli`         | Command-line interface.      |
| `@birdybeep/agent-core`  | Shared adapter runtime.      |
| `@birdybeep/claude-code` | Claude Code adapter.         |
| `@birdybeep/codex`       | Codex adapter.               |
| `@birdybeep/opencode`    | OpenCode plugin and adapter. |
| `@birdybeep/cursor`      | Cursor adapter.              |
| `@birdybeep/copilot`     | GitHub Copilot CLI adapter.  |

## Develop

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

Workspace development requires Node `>=22.11.0` and pnpm `>=10`. Published packages support Node `>=20.11.0`.

## License

[MIT](./LICENSE)
