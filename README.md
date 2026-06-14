# birdybeep-agent

Public, **MIT-licensed** half of [BirdyBeep](https://birdybeep.dev): the open-source
CLI (`@birdybeep/cli`) and the agent adapters (Claude Code, Codex, OpenCode) that run
inside developers' coding harnesses, normalize lifecycle events, and ship them to the
BirdyBeep backend.

This code runs in your dev environment, so it is auditable on purpose — trust and
transparency are features.

## Packages

| Package                  | Description                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `@birdybeep/cli`         | The `birdybeep` CLI: login, status, doctor, agent install/uninstall, hook               |
| `@birdybeep/agent-core`  | Event schema, normalizer/redaction, local queue, sender, token store, adapter interface |
| `@birdybeep/claude-code` | Claude Code adapter + hook templates                                                    |
| `@birdybeep/codex`       | Codex adapter + config templates                                                        |
| `@birdybeep/opencode`    | OpenCode plugin/adapter                                                                 |

## Develop

```bash
pnpm install
pnpm build       # turbo run build — tsup ESM/CJS + d.ts per package
pnpm lint
pnpm typecheck
pnpm test
```

Requires Node `>=20.11.0` and pnpm `>=10`.

## Docs

See [`docs/`](./docs) for install, pairing, security, and troubleshooting guides.

## License

[MIT](./LICENSE) © Mojave Labs
