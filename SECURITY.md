# Security policy

BirdyBeep's public CLI runs inside coding harnesses, edits user-level configuration, and reads a
machine credential at event time. We take credential exposure, config corruption, command execution,
privacy leaks, dependency compromise, and backend authentication bypasses seriously.

## Report privately

Do not open a public issue for a vulnerability. Use this repository's
[private vulnerability reporting](https://github.com/Mojave-Labs/birdybeep-agent/security/advisories/new)
form. If GitHub does not show that form, contact the maintainers through the organization profile to
establish a private channel before sharing details.

Include the affected BirdyBeep/harness versions, operating system, impact, and minimal reproduction.
Never send a live machine token; use a synthetic marker and redact prompts, tool data, PII, and
private paths. Maintainers will acknowledge the report, coordinate a fix and disclosure window, and
credit the reporter if requested. Response timing depends on severity and reproducibility.

## Supported versions

Security fixes target the latest published `@birdybeep/*` release. If the issue also affects an older
release, the advisory will say whether a backport is available.

## Public hardening model

- Package releases use SHA-pinned GitHub Actions and npm trusted publishing/provenance.
- Machine tokens are stored in the OS keychain or a strict-permission file and are never written to
  harness or repository config.
- Adapter payloads are normalized locally: absolute paths are hashed, secret-shaped strings are
  redacted, long fields are truncated, and raw prompts/replies/tool data are dropped by design.
- CODEOWNERS review protects credential, adapter, workflow, and release surfaces.

See [docs/security.md](./docs/security.md) for the data model and exact local sanitization behavior.
