---
"@birdybeep/agent-core": patch
"@birdybeep/claude-code": patch
"@birdybeep/codex": patch
"@birdybeep/opencode": patch
"@birdybeep/cli": patch
---

Add the `repository` field (with monorepo `directory`) to every published package.json, pointing at the public GitHub repo. Required for npm provenance and Trusted Publishing (OIDC) to validate the publishing repository, and it makes the "Repository" link on npmjs.com work.
