# @birdybeep/cli

## 0.0.1

### Patch Changes

- 7501058: Point the default backend URL at the production API on the custom domain (`https://api.birdybeep.com`). Previously defaulted to the unprovisioned `api.birdybeep.dev`. Override still works via `BIRDYBEEP_API_URL` or `birdybeep login`.
- 11b72f2: Add the `repository` field (with monorepo `directory`) to every published package.json, pointing at the public GitHub repo. Required for npm provenance and Trusted Publishing (OIDC) to validate the publishing repository, and it makes the "Repository" link on npmjs.com work.
- Updated dependencies [11b72f2]
- Updated dependencies [8a385a5]
  - @birdybeep/agent-core@0.0.1
  - @birdybeep/claude-code@0.0.1
  - @birdybeep/codex@0.0.1
  - @birdybeep/opencode@0.0.1
