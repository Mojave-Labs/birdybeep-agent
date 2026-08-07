# Public repository hardening runbook

This runbook is the human-only final step for `Mojave-Labs/birdybeep-agent`. All files and workflows
are prepared in the repository; a GitHub organization/repository administrator must apply the live
settings and add staging credentials. Never paste secret values into an issue, PR, command log, or
repository file.

## 1. Configure Actions secrets

In **Settings → Secrets and variables → Actions**, create repository secrets:

| Name                  | Value contract                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STAGING_API_URL`     | HTTPS base URL for a non-production BirdyBeep Worker; no path or trailing slash. It must not be `https://api.birdybeep.com`.                         |
| `STAGING_AGENT_TOKEN` | Revocable, staging-only machine token accepted by that Worker. Scope it to the CI machine/account and rotate it after exposure or personnel changes. |

Do not create plaintext Actions variables for either value. The
[`Staging E2E`](../.github/workflows/staging-e2e.yml) workflow passes the two secrets only to the
five-harness contract probe. It never runs from a pull-request checkout: secret-bearing code runs
from reviewed `main` after merge or by explicit maintainer dispatch.

Trigger **Actions → Staging E2E → Run workflow** after adding the secrets. All three jobs must pass:

- `staging e2e (ubuntu-latest)`
- `staging e2e (macos-latest)`
- `staging e2e (windows-latest)`

Each job installs/uninstalls all five adapters in an isolated profile and sends non-notifying real
SessionStart payload shapes through the built CLI. A green job proves the secret names are readable
and staging returned HTTP 202; it never prints either secret or event content.

## 2. Protect `main`

In **Settings → Branches → Add branch protection rule**, target `main` and enable:

- Require a pull request before merging with at least one approving review.
- Dismiss stale approvals when new commits are pushed.
- Require review from Code Owners.
- Require conversation resolution before merging.
- Require status checks to pass and require branches to be up to date.
- Required checks: `verify (ubuntu-latest)`, `verify (macos-latest)`,
  `verify (windows-latest)`, and `changeset status`.
- Require linear history.
- Include administrators / do not allow bypass for routine changes.
- Block force pushes and branch deletion.

Keep the secret-bearing Staging E2E workflow post-merge rather than making it a PR check. Running PR
code with a staging machine token would let a malicious patch exfiltrate the token before review.

Confirm private vulnerability reporting is enabled under **Settings → Security → Code security and
analysis**, and confirm Issues and Discussions do not expose a security-report template that asks for
secret material.

## 3. Verify the live configuration

After merging the checked-in policy files:

1. Open a test PR that changes a CODEOWNERS-covered path. Confirm `@becs-n-bytes` is automatically
   requested and the PR cannot merge before approval.
2. Make one required CI check fail on the test PR. Confirm GitHub blocks the merge; then restore the
   check and confirm all four required contexts pass.
3. Confirm force-push and delete are disabled for `main` and the protection UI shows administrators
   included.
4. Run the Staging E2E workflow and retain links to the three green jobs. Do not copy logs containing
   request details into the ticket.
5. Read back configuration metadata without reading secret values:

   ```bash
   gh api repos/Mojave-Labs/birdybeep-agent/branches/main/protection
   gh api repos/Mojave-Labs/birdybeep-agent/actions/secrets --jq '.secrets[].name'
   ```

   The second command must list `STAGING_API_URL` and `STAGING_AGENT_TOKEN`. GitHub's API exposes only
   secret names and timestamps, never values.

Record the protection readback, secret-name readback, blocked-merge evidence, CODEOWNERS request, and
green workflow URLs on Beads ticket `birdybeep-agent-43x`. Only then close that human-required ticket
and its parent epic.
